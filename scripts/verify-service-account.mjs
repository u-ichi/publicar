import fs from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/verify-service-account.mjs [--vars-file path] [--write]\n設定: GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, TEAM_DRIVE_ID, PUBLICAR_VERIFY_FOLDER_ID\n--writeは確認用フォルダでファイルを作成・読取・ゴミ箱移動します。');
  process.exit(0);
}
let varsFile = path.join(root, '.dev.vars');
let write = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--write') write = true;
  else if (args[index] === '--vars-file' && args[index + 1]) varsFile = path.resolve(args[++index]);
  else { console.error('不明な引数です。--helpを確認してください。'); process.exit(2); }
}
let vars = {};
try { vars = parseEnv(await fs.readFile(varsFile, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const settings = { ...vars, ...process.env };
const required = ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY', 'TEAM_DRIVE_ID', 'PUBLICAR_VERIFY_FOLDER_ID'];
const missing = required.filter(name => !settings[name]);
if (missing.length) {
  console.error('実Google接続は未実施。未設定: ' + missing.join(', '));
  process.exit(2);
}
// 実際の認証情報を含めずに、Workerと同じ認証・Drive処理をメモリへ読み込む。
const result = await build({ stdin: { resolveDir: root, sourcefile: 'service-account-probe.ts', contents: `
  export { withServiceAccount } from './src/auth/service-account';
  export { verifyServiceAccountLocation } from './src/storage/service-account-drive';
  export { uploadDriveFile, downloadDriveFile, trashDriveFile } from './src/storage/drive';
` }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const env = {
  GOOGLE_SERVICE_ACCOUNT_EMAIL: settings.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: settings.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
  TEAM_DRIVE_ID: settings.TEAM_DRIVE_ID
};
const folder = settings.PUBLICAR_VERIFY_FOLDER_ID;
let uploadedFile = null;
let success = false;
try {
  await api.withServiceAccount(env, token => api.verifyServiceAccountLocation(env, token, folder));
  if (write) {
    const id = crypto.randomUUID();
    const body = new TextEncoder().encode('publicar connection check\n' + id + '\n').buffer;
    uploadedFile = await api.withServiceAccount(env, token => api.uploadDriveFile(env, token, {
      parentId: folder, name: 'publicar-connection-check-' + id + '.txt', mimeType: 'text/plain', body, uploadObjectId: 'probe_' + id
    }));
    const fetched = await api.withServiceAccount(env, async token => {
      await api.verifyServiceAccountLocation(env, token, folder, uploadedFile.id);
      const response = await api.downloadDriveFile(env, token, uploadedFile.id);
      if (response.status === 401) throw new Error('Drive download failed with 401');
      return response;
    });
    if (fetched.status !== 200 || !Buffer.from(fetched.body).equals(Buffer.from(body))) throw new Error('読み取った内容が一致しません。');
  }
  success = true;
} catch {
  console.error('実Google接続の確認に失敗しました。秘密鍵・共有ドライブ・確認用フォルダの権限を確認してください。');
  process.exitCode = 1;
} finally {
  if (uploadedFile) {
    try { await api.withServiceAccount(env, token => api.trashDriveFile(env, token, uploadedFile.id)); }
    catch {
      success = false;
      process.exitCode = 1;
      console.error('確認用ファイルの整理が未完了です。指定した確認用フォルダのpublicar-connection-checkファイルを確認してください。');
    }
  }
}
if (success) console.log(write ? 'サービスアカウントによる権限確認・保存・読取・ゴミ箱移動に成功しました。' : 'サービスアカウントで確認用フォルダの権限を読み取れました。書込は実施していません。');
