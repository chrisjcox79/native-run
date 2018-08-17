import * as Debug from 'debug';
import * as fs from 'fs';
import * as util from 'util';

const debug = Debug('native-run:utils');

export const stat = util.promisify(fs.stat);
export const readdir = util.promisify(fs.readdir);
export const readFile = util.promisify(fs.readFile);

export const safeStat = async (p: string): Promise<fs.Stats | undefined> => {
  try {
    return await stat(p);
  } catch (e) {
    // ignore
  }
};

export const isDir = async (p: string): Promise<boolean> => {
  const stats = await safeStat(p);

  if (stats && stats.isDirectory()) {
    return true;
  }

  return false;
};

export type INIGuard<T extends object> = (o: any) => o is T;

export async function readINI<T extends object>(p: string, guard: INIGuard<T> = (o: any): o is T => true): Promise<T | undefined> {
  const ini = await import('ini');

  try {
    const contents = await readFile(p, 'utf8');
    const config = ini.decode(contents);

    if (!guard(config)) {
      throw new Error(
        `Invalid ini configuration file: ${p}\n` +
        `The following guard was used: ${guard.toString()}`
      );
    }

    return { __filename: p, ...config as any };
  } catch (e) {
    debug(e);
  }
}

export function getOptionValue(args: string[], arg: string): string | undefined;
export function getOptionValue(args: string[], arg: string, defaultValue: string): string;
export function getOptionValue(args: string[], arg: string, defaultValue?: string): string | undefined {
  const i = args.indexOf(arg);

  if (i >= 0) {
    return args[i + 1];
  }

  return defaultValue;
}
