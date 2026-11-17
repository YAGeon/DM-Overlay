'use strict';

/**
 * Сборка portable-версии приложения для Windows.
 *
 * Результат: dist/DM Overlay-win32-x64/DM Overlay.exe
 * Запуск: npm run build
 */

const path = require('path');
const fs = require('fs');
const packager = require('@electron/packager');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));

const IGNORE = [
  /^\/dist(\/|$)/,
  /^\/scripts(\/|$)/,
  /^\/\.git(\/|$)/,
  /^\/assets\/icon\.ico$/,
  /\.bat$/,
  /^\/README\.md$/,
];

async function main() {
  const out = path.join(root, 'dist');
  console.log(`Собираю ${pkg.name} v${pkg.version}…`);

  const paths = await packager({
    dir: root,
    name: 'DM Overlay',
    platform: 'win32',
    arch: 'x64',
    out,
    overwrite: true,
    icon: path.join(root, 'assets', 'icon.ico'),
    appVersion: pkg.version,
    appCopyright: '',
    win32metadata: {
      FileDescription: 'DM Overlay',
      ProductName: 'DM Overlay',
      CompanyName: 'DM Overlay',
      InternalName: 'DM Overlay',
      OriginalFilename: 'DM Overlay.exe',
    },
    ignore: IGNORE,
    prune: true,
  });

  for (const dir of paths) {
    const exe = path.join(dir, 'DM Overlay.exe');
    if (!fs.existsSync(exe)) continue;
    const size = fs.statSync(exe).size;
    console.log(`Готово: ${exe} (${(size / 1024 / 1024).toFixed(1)} МБ)`);
    console.log('Можно запускать двойным кликом — установка не нужна.');
  }
}

main().catch((e) => {
  console.error('ОШИБКА сборки:', e.message);
  process.exit(1);
});
