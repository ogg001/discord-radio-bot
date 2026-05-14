import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Station = {
  name: string;
  url: string;
};

export type Stations = Record<string, Station>;

const STATIONS_FILE = resolve(process.cwd(), 'stations.json');
const EXAMPLE_FILE = resolve(process.cwd(), 'stations.example.json');

export function loadStations(): Stations {
  const filePath = existsSync(STATIONS_FILE) ? STATIONS_FILE : EXAMPLE_FILE;
  const raw = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as Stations;

  for (const [key, station] of Object.entries(parsed)) {
    if (!station.name || !station.url) {
      throw new Error(`Station "${key}" must have both "name" and "url".`);
    }
  }

  return parsed;
}

export function findStation(stations: Stations, key: string): Station | undefined {
  return stations[key.toLowerCase()];
}

export function formatStations(stations: Stations): string {
  const entries = Object.entries(stations);

  if (entries.length === 0) {
    return 'No stations configured.';
  }

  return entries
    .map(([key, station]) => `• \`${key}\` — ${station.name}`)
    .join('\n');
}
