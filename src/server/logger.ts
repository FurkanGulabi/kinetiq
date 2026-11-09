/**
 * Backend logger (was src/server/cnc/lib/logger.js, CNCjs).
 *
 * A thin wrapper around one shared winston logger. Every line looks like
 *   2026-11-09T12:00:00.000Z - info service:configstore message
 * (ISO timestamp, colourised level, cyan namespace, then util.format() of the arguments).
 * With verbosity >= 3 (-vvv) the caller's stack frame is appended to every non-silly line.
 */
import util from 'util';
import chalk from 'chalk';
import winston from 'winston';
import settings from './config/settings';

// https://code.google.com/p/v8/wiki/JavaScriptStackTraceApi
const getStackTrace = (): string[] => {
  const obj: { stack?: string } = {};
  Error.captureStackTrace(obj, getStackTrace);
  return (obj.stack || '').split('\n');
};

const VERBOSITY_MAX = 3; // -vvv

const { combine, colorize, timestamp, printf } = winston.format;

// https://github.com/winstonjs/winston/blob/master/README.md#creating-your-own-logger
const logger = winston.createLogger({
  exitOnError: false,
  level: settings.winston.level,
  silent: false,
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp(),
        printf(log => `${log.timestamp} - ${log.level} ${log.message}`)
      ),
      handleExceptions: true
    })
  ]
});

export type LogLevel = 'error' | 'warn' | 'info' | 'verbose' | 'debug' | 'silly';

/** One namespaced logger: a method per level, each taking util.format()-style arguments. */
export type Logger = Record<LogLevel, (...args: unknown[]) => winston.Logger>;

// https://github.com/winstonjs/winston/blob/master/README.md#logging-levels
// npm logging levels are prioritized from 0 to 5 (highest to lowest):
export const levels: LogLevel[] = [
  'error', // 0
  'warn', // 1
  'info', // 2
  'verbose', // 3
  'debug', // 4
  'silly', // 5
];

export const getLevel = (): string => logger.level;
export const setLevel = (level: string): void => {
  logger.level = level;
};

export default (namespace: unknown = ''): Logger => {
  const ns = String(namespace);

  return levels.reduce((acc, level) => {
    // Keep this a direct call of getStackTrace(): frame [2] must be the caller of acc[level]().
    acc[level] = function(...args: unknown[]) {
      if ((settings.verbosity >= VERBOSITY_MAX) && (level !== 'silly')) {
        args = args.concat(getStackTrace()[2]);
      }
      return (ns.length > 0)
        ? logger[level](chalk.cyan(ns) + ' ' + util.format(...args))
        : logger[level](util.format(...args));
    };
    return acc;
  }, {} as Logger);
};
