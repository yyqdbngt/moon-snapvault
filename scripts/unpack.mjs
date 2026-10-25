// Extracts a MoonBit package archive.
//
// Shared because two checks now need the unpacked archive rather than the source tree:
// `package-smoke.mjs` runs the shipped CLI and tests inside it, and `attribution.mjs` verifies
// that the license texts the attribution promises actually reach the consumer. The first version
// of the attribution check used `moon package --list` instead - which lists top-level entries only,
// so it reported that `third_party/*.txt` was missing from a package that contains them. The
// archive answers the question; the listing does not.
//
// `unzip` is not on every Windows image and PowerShell is not on Linux or macOS, so the tool is
// chosen by platform and arguments go through spawnSync's array form rather than a shell string -
// a path containing a space or a quote then needs no escaping.
import {spawnSync} from 'node:child_process';

export function unpack(archivePath, destination) {
  const attempts = process.platform === 'win32'
    ? [['powershell', ['-NoProfile', '-Command',
      `Expand-Archive -Force -LiteralPath '${archivePath}' -DestinationPath '${destination}'`]]]
    : [['unzip', ['-q', '-o', archivePath, '-d', destination]]];
  const problems = [];
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, {encoding: 'utf8'});
    if (!result.error && result.status === 0) return;
    problems.push(`${command}: ${result.error ? result.error.message : (result.stderr || result.stdout)}`);
  }
  throw new Error('cannot extract ' + archivePath + ':\n' + problems.join('\n'));
}
