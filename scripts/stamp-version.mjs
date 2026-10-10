// Stamps a copy of the site with a version, at publish time. Browsers keep script files for a
// while, and this site is a dozen files that load each other: without a version in each address
// a visitor can run old code for minutes after a release, or a mix of old and new.
//   node scripts/stamp-version.mjs <site folder> <version>
// Every "./file.js" a script loads, and the two files the page loads, get "?v=<version>".
// version.json holds the same version, so an open page can notice that a newer one is out.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function stampScript(text, version) {
  return text.replace(/(\bfrom\s+')(\.{1,2}\/[^'?]+\.js)(')/g, `$1$2?v=${version}$3`);
}

export function stampPage(html, version) {
  return html
    .replace(/(<meta name="evaldesk-version" content=")[^"]*(")/, `$1${version}$2`)
    .replace(/(src="app\.js)(")/, `$1?v=${version}$2`)
    .replace(/(href="styles\.css)(")/, `$1?v=${version}$2`);
}

export async function stampSite(folder, version) {
  if (!/^[\w.-]{1,40}$/.test(version)) throw new Error('The version may only hold letters, digits, dots, dashes and underscores.');
  const names = (await readdir(folder, { recursive: true })).filter((name) => name.endsWith('.js'));
  for (const name of names) {
    const path = join(folder, name);
    await writeFile(path, stampScript(await readFile(path, 'utf8'), version));
  }
  const page = join(folder, 'index.html');
  await writeFile(page, stampPage(await readFile(page, 'utf8'), version));
  await writeFile(join(folder, 'version.json'), `${JSON.stringify({ version })}\n`);
  return { scripts: names.length, version };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [folder, version] = process.argv.slice(2);
  if (!folder || !version) throw new Error('Usage: node scripts/stamp-version.mjs <site folder> <version>');
  const result = await stampSite(folder, version);
  console.log(`Stamped ${result.scripts} scripts and the page with version ${result.version}.`);
}
