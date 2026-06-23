module.exports = {
  presets: [
    // `modules: 'commonjs'` forces preset-env to down-compile ESM to CJS.
    // Without it, Node 25 + targets:current keeps ESM as-is and jest's
    // classic CJS runtime can't load transformed modules from Ink.
    ['@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }],
    ['@babel/preset-typescript', {
      allowDeclareFields: true,
      isTSX: true,
      allExtensions: true,
    }],
    ['@babel/preset-react', { runtime: 'automatic' }],
  ],
};