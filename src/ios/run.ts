import { mkdirp, readDir } from '@ionic/utils-fs';
import { spawnSync } from 'child_process';
import * as Debug from 'debug';
import { createWriteStream, mkdtempSync, readFileSync } from 'fs';
import { AFCError, AFC_STATUS, ClientManager, IPLookupResult } from 'node-ioslib';
import * as path from 'path';
import { Readable } from 'stream';
import { promisify } from 'util';
import { Entry, Options, ZipFile } from 'yauzl';

import { RunException } from '../errors';
import { getOptionValue } from '../utils/cli';
import { execFile } from '../utils/process';

import { getConnectedDevicesInfo, getSimulators } from './utils/device';

const debug = Debug('native-run:ios:run');
const wait = promisify(setTimeout);

export async function run(args: string[]) {
  let appPath = getOptionValue(args, '--app');
  if (!appPath) {
    throw new RunException('--app argument is required.');
  }
  const udid = getOptionValue(args, '--target');
  const preferSimulator = args.includes('--simulator');

  const isIPA = appPath.endsWith('.ipa');
  try {
    if (isIPA) {
      const { tmpdir } = await import('os');
      const tempDir = mkdtempSync(`${tmpdir()}${path.sep}`);
      debug(`Unzipping .ipa to ${tempDir}`);
      const appDir = await unzipApp(appPath, tempDir);
      appPath = path.join(tempDir, appDir);
    }

    const bundleId = await getBundleId(appPath);

    if (udid) {
      for (const device of await getConnectedDevicesInfo()) {
        if (device.id === udid) {
          return runOnDevice(udid, appPath, bundleId);
        }
      }
      for (const simulator of await getSimulators()) {
        if (simulator.id === udid) {
          return runOnSimulator(udid, appPath, bundleId);
        }
      }
      throw new Error(`No device or simulator with udid ${udid} found`);

    } else if (preferSimulator) {
      // use default sim
      const simulators = await getSimulators();
      return runOnSimulator(simulators[simulators.length - 1].id, appPath, bundleId);

    } else {
      // are there connected devices? use first one
      const devices = await getConnectedDevicesInfo();
      if (devices.length) {
        return runOnDevice(devices[0].id, appPath, bundleId);
      }
      // otherwise use default sim
      const simulators = await getSimulators();
      return runOnSimulator(simulators[simulators.length - 1].id, appPath, bundleId);
    }
  } finally {
    if (isIPA) {
      try { (await import('rimraf')).sync(appPath); } catch { } // tslint:disable-line
    }
  }

}

async function runOnSimulator(udid: string, appPath: string, bundleId: string) {
  debug(`Booting simulator ${udid}`);
  const bootResult = spawnSync('xcrun', ['simctl', 'boot', udid], { encoding: 'utf8' });
  // is there a better way to check this?
  if (bootResult.status && !bootResult.stderr.includes('Unable to boot device in current state: Booted')) {
    throw new Error(`There was an error booting simulator: ${bootResult.stderr}`);
  }
  debug(`Installing ${appPath} on ${udid}`);
  const installResult = spawnSync('xcrun', ['simctl', 'install', udid, appPath], { encoding: 'utf8' });
  if (installResult.status) {
    throw new Error(`There was an error installing app on simulator: ${installResult.stderr}`);
  }
  const xCodePath = await getXCodePath();
  debug(`Running simulator ${udid}`);
  const openResult = spawnSync('open', [`${xCodePath}/Applications/Simulator.app`, '--args', '-CurrentDeviceUDID', udid], { encoding: 'utf8' });
  if (openResult.status) {
    throw new Error(`There was an error opening simulator: ${openResult.stderr}`);
  }
  debug(`Launching ${appPath} on ${udid}`);
  const launchResult = spawnSync('xcrun', ['simctl', 'launch', udid, bundleId], { encoding: 'utf8' });
  if (launchResult.status) {
    throw new Error(`There was an error launching app on simulator: ${launchResult.stderr}`);
  }
}

async function runOnDevice(udid: string, appPath: string, bundleId: string) {
  const clientManager = await ClientManager.create(udid);

  try {
    await mountDeveloperDiskImage(clientManager);

    const packageName = path.basename(appPath);
    const destPackagePath = path.join('PublicStaging', packageName);

    await uploadApp(clientManager, appPath, destPackagePath);

    const installer = await clientManager.getInstallationProxyClient();
    await installer.installApp(destPackagePath, bundleId);

    const { [bundleId]: appInfo } = await installer.lookupApp([bundleId]);
    // launch fails with EBusy or ENotFound if you try to launch immediately after install
    await wait(200);
    await launchApp(clientManager, appInfo);

  } finally {
    clientManager.end();
  }
}

async function mountDeveloperDiskImage(clientManager: ClientManager) {
  const imageMounter = await clientManager.getMobileImageMounterClient();
  // Check if already mounted. If not, mount.
  if (!(await imageMounter.lookupImage()).ImageSignature) {
    // verify DeveloperDiskImage exists (TODO: how does this work on Windows/Linux?)
    // TODO: if windows/linux, download?
    const version = await (await clientManager.getLockdowndClient()).getValue('ProductVersion');
    const developerDiskImagePath = await getDeveloperDiskImagePath(version);
    const developerDiskImageSig = readFileSync(`${developerDiskImagePath}.signature`);
    await imageMounter.uploadImage(developerDiskImagePath, developerDiskImageSig);
    await imageMounter.mountImage(developerDiskImagePath, developerDiskImageSig);
  }
}

async function uploadApp(clientManager: ClientManager, srcPath: string, destinationPath: string) {
  const afcClient = await clientManager.getAFCClient();
  try {
    await afcClient.getFileInfo('PublicStaging');
  } catch (err) {
    if (err instanceof AFCError && err.status === AFC_STATUS.OBJECT_NOT_FOUND) {
      await afcClient.makeDirectory('PublicStaging');
    } else {
      throw err;
    }
  }
  await afcClient.uploadDirectory(srcPath, destinationPath);
}

async function launchApp(clientManager: ClientManager, appInfo: IPLookupResult[string]) {
  let tries = 0;
  while (tries < 3) {
    const debugServerClient = await clientManager.getDebugserverClient();
    await debugServerClient.setMaxPacketSize(1024);
    await debugServerClient.setWorkingDir(appInfo.Container);
    await debugServerClient.launchApp(appInfo.Path, appInfo.CFBundleExecutable);

    const result = await debugServerClient.checkLaunchSuccess();
    if (result === 'OK') {
      return debugServerClient;
    } else if (result === 'EBusy' || result === 'ENotFound') {
      debug('Device busy or app not found, trying to launch again in .5s...');
      tries++;
      debugServerClient.socket.end();
      await wait(500);
    } else {
      throw new RunException(`There was an error launching app: ${result}`);
    }
  }
  throw new RunException('Unable to launch app, number of tries exceeded');
}

async function getXCodePath() {
  try {
    const { stdout } = await execFile('xcode-select', ['-p'], { encoding: 'utf8' });
    if (stdout) {
      return stdout.trim();
    }
  } catch { } // tslint:disable-line
  throw new Error('Unable to get Xcode location. Is Xcode installed?');
}

async function getDeveloperDiskImagePath(version: string) {
  const xCodePath = await getXCodePath();
  const versionDirs = await readDir(`${xCodePath}/Platforms/iPhoneOS.platform/DeviceSupport/`);
  const versionPrefix = version.match(/\d+\.\d+/);
  if (versionPrefix === null) {
    throw new Error(`Invalid iOS version: ${version}`);
  }
  // Can look like "11.2 (15C107)"
  for (const dir of versionDirs) {
    if (dir.includes(versionPrefix[0])) {
      return `${xCodePath}/Platforms/iPhoneOS.platform/DeviceSupport/${dir}/DeveloperDiskImage.dmg`;
    }
  }
  throw new Error(`Unable to find Developer Disk Image path for SDK ${version}. Do you have the right version of Xcode?`);
}

// TODO: cross platform? Use plist/bplist
async function getBundleId(packagePath: string) {
  const plistPath = path.resolve(packagePath, 'Info.plist');
  try {
    const { stdout } = await execFile('/usr/libexec/PlistBuddy',
                                      ['-c', 'Print :CFBundleIdentifier', plistPath],
                                      { encoding: 'utf8' });
    if (stdout) {
      return stdout.trim();
    }
  } catch { } // tslint:disable-line
  throw new Error('Unable to get app bundle identifier');
}

// Override so promisify typing correctly infers params
type YauzlOpen = (path: string, options: Options, callback?: (err: Error, zipfile: ZipFile) => void) => void;
type YauzlOpenReadStream = (entry: Entry, callback?: (err: Error, stream: Readable) => void) => void;

async function unzipApp(srcPath: string, destPath: string) {
  const yauzl = await import('yauzl');
  const open = promisify(yauzl.open.bind(yauzl) as YauzlOpen);
  let appDir = '';
  return new Promise<string>(async (resolve, reject) => {
    const zipfile = await open(srcPath, { lazyEntries: true });
    const openReadStream = promisify(zipfile.openReadStream.bind(zipfile) as YauzlOpenReadStream);

    zipfile.once('error', reject);
    zipfile.once('end', () => { appDir ? resolve(appDir) : reject('Unable to determine .app directory from .ipa'); });

    zipfile.readEntry();
    zipfile.on('entry', async (entry: Entry) => {
      debug(`Unzip: ${entry.fileName}`);
      const dest = path.join(destPath, entry.fileName);
      if (entry.fileName.endsWith('/')) {
        await mkdirp(dest);
        if (entry.fileName.endsWith('.app/')) {
          appDir = entry.fileName;
        }
        zipfile.readEntry();
      } else {
        await mkdirp(path.dirname(dest));
        const readStream = await openReadStream(entry);
        readStream.on('end', () => { zipfile.readEntry(); });
        const writeStream = createWriteStream(path.join(destPath, entry.fileName));
        readStream.pipe(writeStream);
      }
    });
  });
}
