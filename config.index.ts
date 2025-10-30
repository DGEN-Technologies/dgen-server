// This file dynamically imports the correct config based on NODE_ENV
import devConfig from "./config.ts";
import prodConfig from "./config.production.ts";
import testConfig from "./config.test.ts";

const config = process.env.NODE_ENV === "production" 
  ? prodConfig 
  : process.env.NODE_ENV === "test" 
    ? testConfig 
    : devConfig;

export default config;