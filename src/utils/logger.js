/**
 * Logger Utility
 * Simple logger with different log levels.
 *
 * Per-game capture: every line the logger can attribute to a room is ALSO
 * recorded in the GameLogStore so a single game's timeline can be read back
 * from the dev console. Attribution, in priority order:
 *   1. an explicit room logger (`logger.forRoom(roomId).info(...)`)
 *   2. `data.roomId` on a structured log call
 *   3. the ambient room context — `logger.runWithRoom(roomId, fn)` /
 *      `logger.bindRoom(roomId, fn)` (AsyncLocalStorage, so it follows the
 *      socket event / webhook / timer through every await and setTimeout).
 *      Always SCOPED: there is deliberately no enterWith-style API, because
 *      a context set at the top of a synchronous chain leaks into everything
 *      scheduled after it (the next test, the rest of server boot, ...).
 *   4. a `room <id>` mention in the message, accepted only when the store
 *      already knows that room (so "room not found" never mints a room)
 * The console / daily-file output is unchanged.
 */

const { AsyncLocalStorage } = require('async_hooks');
const config = require('../config');
const fs = require('fs');
const path = require('path');
const GameLogStore = require('../observability/GameLogStore');

const LogLevel = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
};

/** Candidate room ids mentioned in free-text messages ("room abc", "Room: abc", "roomId=abc"). */
const ROOM_MENTION_RE = /\broom(?:Id)?\s*[:=]?\s*([A-Za-z0-9][A-Za-z0-9_.:-]{0,63})/gi;

const roomContext = new AsyncLocalStorage();

class Logger {
  constructor() {
    this.level = this._getLevelFromString(config.logging.level);
    this.enableConsole = config.logging.enableConsole;
    this.enableFile = config.logging.enableFile;
    this.logDirectory = config.logging.logDirectory;

    const gameLog = config.gameLog || {};
    this.gameLogEnabled = gameLog.enabled !== false;
    this.gameLogLevel = this._getLevelFromString(gameLog.level || config.logging.level);
    this.gameLogStore = new GameLogStore({
      retentionMs: gameLog.retentionMs,
      maxEntriesPerRoom: gameLog.maxEntriesPerRoom,
      maxTotalEntries: gameLog.maxTotalEntries,
      fileEnabled: this.gameLogEnabled && gameLog.fileEnabled === true,
      fileDirectory: gameLog.fileDirectory,
    });

    if (this.enableFile) {
      this._ensureLogDirectory();
    }
  }

  /**
   * Log error message
   * @param {string} message
   * @param {Error|Object} error
   */
  error(message, error = null) {
    if (this._wants(LogLevel.ERROR)) {
      this._log('ERROR', message, error);
    }
  }

  /**
   * Log warning message
   * @param {string} message
   * @param {Object} data
   */
  warn(message, data = null) {
    if (this._wants(LogLevel.WARN)) {
      this._log('WARN', message, data);
    }
  }

  /**
   * Log info message
   * @param {string} message
   * @param {Object} data
   */
  info(message, data = null) {
    if (this._wants(LogLevel.INFO)) {
      this._log('INFO', message, data);
    }
  }

  /**
   * Log debug message
   * @param {string} message
   * @param {Object} data
   */
  debug(message, data = null) {
    if (this._wants(LogLevel.DEBUG)) {
      this._log('DEBUG', message, data);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-game capture
  // ---------------------------------------------------------------------------

  /**
   * Run `fn` with `roomId` as the ambient room for every log line it (and
   * anything it awaits or schedules) emits. A null roomId just runs `fn`.
   * @template T
   * @param {string|number|null|undefined} roomId
   * @param {() => T} fn
   * @returns {T}
   */
  runWithRoom(roomId, fn) {
    if (roomId === null || roomId === undefined || roomId === '') return fn();
    return roomContext.run({ roomId: String(roomId) }, fn);
  }

  /**
   * Wrap a callback so it always runs inside `roomId`'s context (timers,
   * listeners). Same as runWithRoom, curried.
   * @param {string|number|null|undefined} roomId
   * @param {Function} fn
   * @returns {Function}
   */
  bindRoom(roomId, fn) {
    if (roomId === null || roomId === undefined || roomId === '') return fn;
    const store = { roomId: String(roomId) };
    return (...args) => roomContext.run(store, () => fn(...args));
  }

  /** The ambient room id, if any. */
  currentRoomId() {
    return roomContext.getStore()?.roomId ?? null;
  }

  /**
   * A logger whose every line is attributed to `roomId` regardless of context.
   * @param {string|number} roomId
   * @returns {{error: Function, warn: Function, info: Function, debug: Function, roomId: string}}
   */
  forRoom(roomId) {
    const id = String(roomId);
    const emit = (level, levelNum) => {
      return (message, data = null) => {
        if (this._wants(levelNum)) this._log(level, message, data, id);
      };
    };
    return {
      roomId: id,
      error: emit('ERROR', LogLevel.ERROR),
      warn: emit('WARN', LogLevel.WARN),
      info: emit('INFO', LogLevel.INFO),
      debug: emit('DEBUG', LogLevel.DEBUG),
    };
  }

  /** Whether either sink (console/file or per-game store) wants this level. */
  _wants(levelNum) {
    return this.level >= levelNum || (this.gameLogEnabled && this.gameLogLevel >= levelNum);
  }

  /**
   * Internal log method
   * @private
   * @param {string} level
   * @param {string} message
   * @param {any} data
   * @param {string|null} explicitRoomId  set by forRoom()
   */
  _log(level, message, data = null, explicitRoomId = null) {
    const timestamp = new Date().toISOString();
    const levelNum = LogLevel[level];

    if (this.level >= levelNum) {
      const logMessage = `[${timestamp}] [${level}] ${message}`;

      if (this.enableConsole) {
        const coloredMessage = this._colorize(level, logMessage);
        console.log(coloredMessage);
        if (data) {
          console.log(data);
        }
      }

      if (this.enableFile) {
        this._writeToFile(logMessage, data);
      }
    }

    if (this.gameLogEnabled && this.gameLogLevel >= levelNum) {
      this._captureForRoom(level, message, data, timestamp, explicitRoomId);
    }
  }

  /**
   * Attribute a line to a room (see the attribution order in the file header)
   * and hand it to the store. Never throws — logging must not take a game down.
   * @private
   */
  _captureForRoom(level, message, data, timestamp, explicitRoomId) {
    try {
      const roomId = explicitRoomId || this._resolveRoomId(message, data);
      if (!roomId) return;
      this.gameLogStore.record(roomId, { level, message, data, timestamp });
    } catch (error) {
      console.error('Failed to capture game log line:', error);
    }
  }

  /** @private */
  _resolveRoomId(message, data) {
    if (data && typeof data === 'object' && !(data instanceof Error)) {
      const fromData = data.roomId;
      if (fromData !== null && fromData !== undefined && fromData !== '') return String(fromData);
    }

    const ambient = roomContext.getStore()?.roomId;
    if (ambient) return ambient;

    if (typeof message === 'string' && message.length < 4096) {
      ROOM_MENTION_RE.lastIndex = 0;
      let match;
      while ((match = ROOM_MENTION_RE.exec(message)) !== null) {
        if (this.gameLogStore.has(match[1])) return match[1];
        // "room abc:" / "room abc." — the sentence punctuation is not part of the id
        const trimmed = match[1].replace(/[.:,;]+$/, '');
        if (trimmed !== match[1] && this.gameLogStore.has(trimmed)) return trimmed;
      }
    }
    return null;
  }

  /**
   * Colorize console output based on log level
   * @private
   * @param {string} level
   * @param {string} message
   * @returns {string}
   */
  _colorize(level, message) {
    const colors = {
      ERROR: '\x1b[31m', // Red
      WARN: '\x1b[33m', // Yellow
      INFO: '\x1b[36m', // Cyan
      DEBUG: '\x1b[90m', // Gray
    };
    const reset = '\x1b[0m';
    return `${colors[level] || ''}${message}${reset}`;
  }

  /**
   * Write log to file
   * @private
   * @param {string} message
   * @param {any} data
   */
  _writeToFile(message, data = null) {
    try {
      const date = new Date().toISOString().split('T')[0];
      const logFile = path.join(this.logDirectory, `${date}.log`);

      let fullMessage = message;
      if (data) {
        fullMessage += '\n' + JSON.stringify(data, null, 2);
      }
      fullMessage += '\n';

      fs.appendFileSync(logFile, fullMessage);
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  /**
   * Ensure log directory exists
   * @private
   */
  _ensureLogDirectory() {
    try {
      if (!fs.existsSync(this.logDirectory)) {
        fs.mkdirSync(this.logDirectory, { recursive: true });
      }
    } catch (error) {
      console.error('Failed to create log directory:', error);
      this.enableFile = false;
    }
  }

  /**
   * Convert string to log level
   * @private
   * @param {string} levelStr
   * @returns {number}
   */
  _getLevelFromString(levelStr) {
    const levels = {
      error: LogLevel.ERROR,
      warn: LogLevel.WARN,
      info: LogLevel.INFO,
      debug: LogLevel.DEBUG,
    };
    return levels[levelStr.toLowerCase()] ?? LogLevel.INFO;
  }
}

// Export singleton instance
module.exports = new Logger();
