/**
 * Logger utility for consistent logging
 */

const config = require('../config');

const logLevels = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

const currentLogLevel = logLevels[config.logging.level.toUpperCase()] || logLevels.INFO;

const formatMessage = (level, message, data = null) => {
  const timestamp = new Date().toISOString();
  const baseMessage = `[${timestamp}] ${level}: ${message}`;
  
  if (data) {
    return `${baseMessage} ${JSON.stringify(data, null, 2)}`;
  }
  
  return baseMessage;
};

const logger = {
  error: (message, data = null) => {
    if (currentLogLevel >= logLevels.ERROR) {
      console.error(formatMessage('ERROR', message, data));
    }
  },

  warn: (message, data = null) => {
    if (currentLogLevel >= logLevels.WARN) {
      console.warn(formatMessage('WARN', message, data));
    }
  },

  info: (message, data = null) => {
    if (currentLogLevel >= logLevels.INFO) {
      console.info(formatMessage('INFO', message, data));
    }
  },

  debug: (message, data = null) => {
    if (currentLogLevel >= logLevels.DEBUG) {
      console.debug(formatMessage('DEBUG', message, data));
    }
  },

  // Request logging
  request: (req, res, duration) => {
    const statusCode = res.statusCode;
    const method = req.method;
    const url = req.originalUrl;
    const ip = req.ip;
    
    const logData = {
      method,
      url,
      statusCode,
      duration: `${duration}ms`,
      ip,
      userAgent: req.get('User-Agent')
    };
    
    if (statusCode >= 400) {
      logger.error(`${method} ${url} - ${statusCode}`, logData);
    } else if (statusCode >= 300) {
      logger.warn(`${method} ${url} - ${statusCode}`, logData);
    } else {
      logger.info(`${method} ${url} - ${statusCode}`, logData);
    }
  }
};

module.exports = logger; 