/**
 * Manages `auth.txt`, the managed backend's credential file.
 *
 *   bun run auth add <username>      add or replace a user
 *   bun run auth list                usernames only
 *   bun run auth remove <username>   drop a user
 *
 * The password is typed, never passed as an argument: an argument is in the
 * shell history, in `ps`, and in the terminal scrollback of whoever is watching
 * the demo. It is read with echo off, twice, and hashed with bcrypt through
 * `Bun.password` — the same function the server verifies with.
 *
 * When stdin is not a terminal the passwords are read as plain lines instead,
 * so `printf 'pw\npw\n' | bun run auth add ci` works in a script.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  BCRYPT_COST,
  DEFAULT_AUTH_FILE,
  EXAMPLE_HASH,
  formatAuthFile,
  isValidUsername,
  parseAuthFile,
} from '../packages/server/src/auth.ts';

const MIN_PASSWORD_LENGTH = 8;

const file = Bun.env.PPG_AUTH_FILE ?? DEFAULT_AUTH_FILE;

function load(): Map<string, string> {
  if (!existsSync(file)) return new Map();
  return parseAuthFile(readFileSync(file, 'utf8'));
}

function save(users: Map<string, string>): void {
  writeFileSync(file, formatAuthFile(users), 'utf8');
  // Hashes, but still: nobody else on the machine needs to read them.
  chmodSync(file, 0o600);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/* ------------------------------------------------------------- password in */

/** Every line of piped stdin, read once, consumed in order by `askHidden`. */
let pipedLines: string[] | null = null;

async function readPiped(): Promise<string[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split('\n');
}

function askHiddenFromTty(question: string): Promise<string> {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((done) => {
    let value = '';

    const finish = (result: string) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      done(result);
    };

    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') return finish(value);
        // Ctrl-C has to be handled by hand: raw mode means the terminal no
        // longer turns it into a signal, and without this the shell is left
        // with echo off.
        if (character === '\u0003') {
          finish('');
          process.exit(130);
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else if (character >= ' ') value += character;
      }
    };

    stdin.on('data', onData);
  });
}

async function askHidden(question: string): Promise<string> {
  if (process.stdin.isTTY) return askHiddenFromTty(question);
  pipedLines ??= await readPiped();
  return (pipedLines.shift() ?? '').replace(/\r$/, '');
}

/* ---------------------------------------------------------------- commands */

async function add(username: string): Promise<void> {
  if (!isValidUsername(username)) {
    fail(`唔合法嘅 username「${username}」。只接受英文字母、數字同 . _ -，最多 64 個字。`);
  }

  const users = load();
  if (users.has(username)) console.log(`「${username}」已經存在，會換成新密碼。`);

  const password = await askHidden(`密碼（${username}）: `);
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`密碼至少要 ${MIN_PASSWORD_LENGTH} 個字元。`);
  }
  const again = await askHidden('再打一次: ');
  if (password !== again) fail('兩次唔一樣。冇改到任何嘢。');

  users.set(username, await Bun.password.hash(password, { algorithm: 'bcrypt', cost: BCRYPT_COST }));
  save(users);

  console.log(`✓ 「${username}」寫咗入 ${file}`);
  console.log('  喺插件嘅設定頁（managed 模式）填返同一組帳號密碼就用得。');
}

function list(): void {
  const users = load();
  if (users.size === 0) {
    console.log(`${file} 冇任何用戶。行 \`bun run auth add <username>\` 加一個。`);
    return;
  }
  for (const [username, hash] of users) {
    console.log(hash === EXAMPLE_HASH ? `${username}  (example line — 唔會登入得到)` : username);
  }
}

function remove(username: string): void {
  const users = load();
  if (!users.delete(username)) fail(`${file} 入面冇「${username}」。`);
  save(users);
  console.log(`✓ 刪咗「${username}」。已經發出嘅 token 要等 server 重啟先會失效。`);
}

/* -------------------------------------------------------------------- main */

const [command, username] = process.argv.slice(2);

switch (command) {
  case 'add':
    if (!username) fail('用法：bun run auth add <username>');
    await add(username);
    break;
  case 'list':
    list();
    break;
  case 'remove':
  case 'rm':
    if (!username) fail('用法：bun run auth remove <username>');
    remove(username);
    break;
  default:
    console.log('用法：bun run auth <add|list|remove> [username]');
    process.exit(command ? 1 : 0);
}
