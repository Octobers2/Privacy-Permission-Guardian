/** The few backend calls the setup page makes. */
import { isUsable, ModelManifestSchema, type ModelEntry } from '@ppg/shared';
import { z } from 'zod';

export function normaliseServer(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The server address must start with https:// or http://');
  return url.origin;
}

export async function fetchModels(serverUrl: string): Promise<ModelEntry[]> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/models/manifest.json`, { cache: 'no-cache' });
  } catch {
    throw new Error(`Could not reach ${serverUrl}. Check the address and that the server is running.`);
  }
  if (!response.ok) throw new Error(`The server answered ${response.status} when asked for its model list.`);
  const parsed = ModelManifestSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error('The server returned a model list this version of the extension does not understand.');
  return parsed.data.models.filter(isUsable);
}

const LoginResponse = z.object({ token: z.string(), expiresAt: z.number() });

export async function signIn(serverUrl: string, username: string, password: string): Promise<{ username: string; token: string; expiresAt: number }> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  } catch {
    throw new Error(`Could not reach ${serverUrl}.`);
  }
  if (response.status === 429) throw new Error('Too many failed attempts. Try again in 15 minutes.');
  if (!response.ok) throw new Error(response.status === 401 ? 'Wrong username or password.' : `The server answered ${response.status}.`);
  const body = LoginResponse.parse(await response.json());
  return { username, token: body.token, expiresAt: body.expiresAt };
}
