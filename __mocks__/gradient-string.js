// Manual mock for gradient-string v3 (ESM-only) for Jest testing
const gradientStringMock = function(colors) {
  return function(text) {
    // Return text with gradient markers for testing
    return `[GRADIENT:${colors.map(c => c.substring(0, 7)).join(',')}]${text}[/GRADIENT]`;
  };
};

// Add static method if needed
gradientStringMock.atlas = function(colors) {
  return function(text) {
    return `[ATLAS-GRADIENT:${colors.map(c => c.substring(0, 7)).join(',')}]${text}[/ATLAS-GRADIENT]`;
  };
};

gradientStringMock.fruit = function(colors) {
  return function(text) {
    return `[FRUIT-GRADIENT:${colors.map(c => c.substring(0, 7)).join(',')}]${text}[/FRUIT-GRADIENT]`;
  };
};

gradientStringMock.pastel = function(colors) {
  return function(text) {
    return `[PASTEL-GRADIENT:${colors.map(c => c.substring(0, 7)).join(',')}]${text}[/PASTEL-GRADIENT]`;
  };
};

gradientStringMock.retro = function(colors) {
  return function(text) {
    return `[RETRO-GRADIENT:${colors.map(c => c.substring(0, 7)).join(',')}]${text}[/RETRO-GRADIENT]`;
  };
};

gradientStringMock.rainbow = function(colors) {
  return function(text) {
    return `[RAINBOW-GRADIENT:${colors.map(c => c.substring(0, 7)).join(',')}]${text}[/RAINBOW-GRADIENT]`;
  };
};

module.exports = gradientStringMock;
module.exports.default = gradientStringMock;
