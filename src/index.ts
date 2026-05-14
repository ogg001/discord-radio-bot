import 'dotenv/config';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import {
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type GuildMember,
} from 'discord.js';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  type AudioPlayer,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from '@discordjs/voice';
import { findStation, formatStations, loadStations, type Station, type Stations } from './stations.js';

type GuildRadioState = {
  stationKey: string;
  stationName: string;
  connection: VoiceConnection;
  player: AudioPlayer;
  ffmpeg: ChildProcessWithoutNullStreams;
};

const token = process.env.DISCORD_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const debugFfmpeg = process.env.DEBUG_FFMPEG === 'true';

if (!token) {
  throw new Error('Missing DISCORD_TOKEN in .env');
}

if (!ffmpegPath) {
  throw new Error('ffmpeg-static did not provide an ffmpeg binary path.');
}

let stations: Stations = loadStations();
const guildStates = new Map<string, GuildRadioState>();

const commands = [
  new SlashCommandBuilder()
    .setName('radio')
    .setDescription('Play a configured audio stream in your voice channel.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('play')
        .setDescription('Play a stream from stations.json.')
        .addStringOption((option) =>
          option
            .setName('station')
            .setDescription('Station key, for example: example')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('stop').setDescription('Stop playback and leave the voice channel.'),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('list').setDescription('List configured streams.'),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('now').setDescription('Show what is currently playing.'),
    ),
].map((command) => command.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

async function registerGuildCommands(applicationId: string): Promise<void> {
  if (!guildId) {
    console.warn('DISCORD_GUILD_ID is not set. Slash commands were not registered.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(token!);
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: commands });
  console.log(`Registered slash commands for guild ${guildId}.`);
}

function createFfmpegProcess(url: string): ChildProcessWithoutNullStreams {
  const args = [
    '-hide_banner',
    '-loglevel',
    debugFfmpeg ? 'warning' : 'error',
    '-reconnect',
    '1',
    '-reconnect_streamed',
    '1',
    '-reconnect_delay_max',
    '5',
    '-i',
    url,
    '-analyzeduration',
    '0',
    '-f',
    's16le',
    '-ar',
    '48000',
    '-ac',
    '2',
    'pipe:1',
  ];

  if (!ffmpegPath) {
    throw new Error('FFmpeg binary path not found.');
  }

  const ffmpeg = spawn(ffmpegPath as unknown as string, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as unknown as ChildProcessWithoutNullStreams;

  ffmpeg.stderr.on('data', (chunk: Buffer) => {
    if (debugFfmpeg) {
      console.warn(`[ffmpeg] ${chunk.toString().trim()}`);
    }
  });

  return ffmpeg;
}

function stopGuildPlayback(guildIdToStop: string): boolean {
  const state = guildStates.get(guildIdToStop);

  if (!state) {
    const existingConnection = getVoiceConnection(guildIdToStop);
    existingConnection?.destroy();
    return false;
  }

  state.player.stop(true);
  state.connection.destroy();

  if (!state.ffmpeg.killed) {
    state.ffmpeg.kill('SIGKILL');
  }

  guildStates.delete(guildIdToStop);
  return true;
}

async function handlePlay(interaction: ChatInputCommandInteraction, stationKey: string): Promise<void> {
  if (!interaction.guild || !interaction.guildId) {
    await interaction.reply({ content: 'This command can only be used on a server.', ephemeral: true });
    return;
  }

  stations = loadStations();
  const normalizedKey = stationKey.toLowerCase();
  const station = findStation(stations, normalizedKey);

  if (!station || station.url === 'STREAM_URL_HERE') {
    await interaction.reply({
      content: `I do not have a valid stream configured for \`${stationKey}\`. Check \`stations.json\`.`,
      ephemeral: true,
    });
    return;
  }

  const member = interaction.member as GuildMember | null;
  const voiceChannel = member?.voice.channel;

  if (!voiceChannel) {
    await interaction.reply({ content: 'Join a voice channel first, then use this command.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  stopGuildPlayback(interaction.guildId);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: voiceChannel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
    selfDeaf: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch {
    connection.destroy();
    await interaction.editReply('I could not join the voice channel. Check my permissions and try again.');
    return;
  }

  const ffmpeg = createFfmpegProcess(station.url);
  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Play,
    },
  });

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw,
    metadata: {
      stationKey: normalizedKey,
      stationName: station.name,
    },
  });

  player.on('error', (error) => {
    console.error(`Audio player error in guild ${interaction.guildId}:`, error);
    stopGuildPlayback(interaction.guildId!);
  });

  player.on(AudioPlayerStatus.Idle, () => {
    const state = guildStates.get(interaction.guildId!);
    if (state?.stationKey === normalizedKey) {
      stopGuildPlayback(interaction.guildId!);
    }
  });

  ffmpeg.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGKILL') {
      console.warn(`ffmpeg exited for ${station.name}. code=${code}, signal=${signal}`);
    }
  });

  connection.subscribe(player);
  player.play(resource);

  guildStates.set(interaction.guildId, {
    stationKey: normalizedKey,
    stationName: station.name,
    connection,
    player,
    ffmpeg,
  });

  await interaction.editReply(`Playing **${station.name}** in **${voiceChannel.name}**.`);
}

async function handleStop(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'This command can only be used on a server.', ephemeral: true });
    return;
  }

  const stopped = stopGuildPlayback(interaction.guildId);
  await interaction.reply(stopped ? 'Stopped playback.' : 'Nothing is playing right now.');
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  stations = loadStations();
  await interaction.reply({ content: formatStations(stations), ephemeral: true });
}

async function handleNow(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: 'This command can only be used on a server.', ephemeral: true });
    return;
  }

  const state = guildStates.get(interaction.guildId);
  await interaction.reply(state ? `Now playing: **${state.stationName}**` : 'Nothing is playing right now.');
}

async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  stations = loadStations();
  const focused = interaction.options.getFocused().toLowerCase();

  const choices = Object.entries(stations)
    .filter(([key, station]) => key.includes(focused) || station.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(([key, station]) => ({
      name: `${key} — ${station.name}`,
      value: key,
    }));

  await interaction.respond(choices);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}.`);
  await registerGuildCommands(readyClient.application.id);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName !== 'radio') {
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'play') {
      const stationKey = interaction.options.getString('station', true);
      await handlePlay(interaction, stationKey);
      return;
    }

    if (subcommand === 'stop') {
      await handleStop(interaction);
      return;
    }

    if (subcommand === 'list') {
      await handleList(interaction);
      return;
    }

    if (subcommand === 'now') {
      await handleNow(interaction);
    }
  } catch (error) {
    console.error(error);

    if (interaction.isRepliable()) {
      const message = 'Something went wrong. Check the bot logs.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message);
      } else {
        await interaction.reply({ content: message, ephemeral: true });
      }
    }
  }
});

process.on('SIGINT', () => {
  for (const guildIdToStop of guildStates.keys()) {
    stopGuildPlayback(guildIdToStop);
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  for (const guildIdToStop of guildStates.keys()) {
    stopGuildPlayback(guildIdToStop);
  }
  process.exit(0);
});

await client.login(token);
