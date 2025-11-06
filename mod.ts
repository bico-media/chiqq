// Deno entry point - re-export the ES6 bundle
export {default} from './dist/index.es6.js';

// Export types from the source TypeScript file
export type {Configuration, ConfigTask} from './src/index.ts';
