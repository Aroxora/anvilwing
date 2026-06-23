// Manual mock for chalk@5 (ESM-only) for Jest testing
const chalkMock = Object.create(null);

// Basic styling methods
chalkMock.bold = (text) => `\x1b[1m${text}\x1b[22m`;
chalkMock.dim = (text) => `\x1b[2m${text}\x1b[22m`;
chalkMock.italic = (text) => `\x1b[3m${text}\x1b[23m`;
chalkMock.underline = (text) => `\x1b[4m${text}\x1b[24m`;

// Color shortcuts
chalkMock.red = (text) => `\x1b[31m${text}\x1b[39m`;
chalkMock.green = (text) => `\x1b[32m${text}\x1b[39m`;
chalkMock.yellow = (text) => `\x1b[33m${text}\x1b[39m`;
chalkMock.blue = (text) => `\x1b[34m${text}\x1b[39m`;
chalkMock.magenta = (text) => `\x1b[35m${text}\x1b[39m`;
chalkMock.cyan = (text) => `\x1b[36m${text}\x1b[39m`;
chalkMock.white = (text) => `\x1b[37m${text}\x1b[39m`;
chalkMock.gray = (text) => `\x1b[90m${text}\x1b[39m`;
chalkMock.black = (text) => `\x1b[30m${text}\x1b[39m`;

// Background colors
chalkMock.bgRed = (text) => `\x1b[41m${text}\x1b[49m`;
chalkMock.bgGreen = (text) => `\x1b[42m${text}\x1b[49m`;
chalkMock.bgYellow = (text) => `\x1b[43m${text}\x1b[49m`;
chalkMock.bgBlue = (text) => `\x1b[44m${text}\x1b[49m`;
chalkMock.bgMagenta = (text) => `\x1b[45m${text}\x1b[49m`;
chalkMock.bgCyan = (text) => `\x1b[46m${text}\x1b[49m`;
chalkMock.bgWhite = (text) => `\x1b[47m${text}\x1b[49m`;
chalkMock.bgBlack = (text) => `\x1b[40m${text}\x1b[49m`;

// Static properties
chalkMock.supportsColor = { level: 3, hasBasic: true, has256: true, has16m: true };

// Hex method
chalkMock.hex = (color) => {
  const fn = (text) => {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
  };
  fn.bold = (text) => {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `\x1b[1m\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
  };
  return fn;
};

// Background hex method
chalkMock.bgHex = (color) => {
  const fn = (text) => {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `\x1b[48;2;${r};${g};${b}m${text}\x1b[0m`;
  };
  fn.hex = (textColor) => {
    const bgR = parseInt(color.slice(1, 3), 16);
    const bgG = parseInt(color.slice(3, 5), 16);
    const bgB = parseInt(color.slice(5, 7), 16);
    const fgR = parseInt(textColor.slice(1, 3), 16);
    const fgG = parseInt(textColor.slice(3, 5), 16);
    const fgB = parseInt(textColor.slice(5, 7), 16);
    return (text) => {
      return `\x1b[48;2;${bgR};${bgG};${bgB}m\x1b[38;2;${fgR};${fgG};${fgB}m${text}\x1b[0m`;
    };
  };
  return fn;
};

module.exports = chalkMock;
module.exports.default = chalkMock;
