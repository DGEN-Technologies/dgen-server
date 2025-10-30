import { exit } from "process";

interface EnvironmentConfig {
  required: string[];
  production: string[];
  secure: string[];
}

const CONFIG_REQUIREMENTS: EnvironmentConfig = {
  required: [
    'NODE_ENV',
    'PORT'
  ],
  production: [
    'JWT_SECRET',
    'ADMIN_PASSWORD'
  ],
  secure: [
    'JWT_SECRET',
    'ADMIN_PASSWORD'
  ]
};

export function validateConfiguration(): void {
  const env = process.env.NODE_ENV || 'development';
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const varName of CONFIG_REQUIREMENTS.required) {
    if (!process.env[varName]) {
      errors.push(`Missing required environment variable: ${varName}`);
    }
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (jwtSecret && jwtSecret.length > 0) {
    validateSecureVariable('JWT_SECRET', jwtSecret, errors, warnings);
  }

  if (env === 'production') {
    for (const varName of CONFIG_REQUIREMENTS.production) {
      const value = process.env[varName];
      if (!value) {
        errors.push(`Missing production environment variable: ${varName}`);
      } else if (CONFIG_REQUIREMENTS.secure.includes(varName)) {
        validateSecureVariable(varName, value, errors, warnings);
      }
    }

    validateProductionSpecific(errors, warnings);
  }

  if (errors.length > 0) {
    console.error('\n❌ CONFIGURATION ERRORS:');
    errors.forEach(error => console.error(`  - ${error}`));
    console.error('\nApplication cannot start with invalid configuration.\n');
    exit(1);
  }

  if (warnings.length > 0) {
    console.warn('\n⚠️  CONFIGURATION WARNINGS:');
    warnings.forEach(warning => console.warn(`  - ${warning}`));
    console.warn('');
  }
}

function validateSecureVariable(
  varName: string,
  value: string,
  errors: string[],
  warnings: string[]
): void {
  if (value.includes('dev') || value.includes('test') || value.includes('change')) {
    errors.push(`${varName} appears to contain development/test values`);
  }

  switch (varName) {
    case 'JWT_SECRET':
      if (value.length < 64) {
        errors.push(`${varName} must be at least 64 characters`);
      }
      if (!/^[a-fA-F0-9]{64,}$/.test(value)) {
        warnings.push(`${varName} should be hexadecimal for optimal security`);
      }
      break;

    case 'ADMIN_PASSWORD':
      if (value.length < 12) {
        errors.push(`${varName} must be at least 12 characters`);
      }
      break;
  }
}

function validateProductionSpecific(errors: string[], warnings: string[]): void {
  const { 
    DATABASE_URL, 
    REDIS_URL, 
    URL,
    HTTPS,
    CORS_ALLOWED_ORIGINS 
  } = process.env;

  // Railway provides RAILWAY_PUBLIC_DOMAIN and RAILWAY_PRIVATE_DOMAIN
  const railwayUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;
  
  if (!URL && !railwayUrl && HTTPS !== 'true') {
    errors.push('Production requires either URL, RAILWAY_PUBLIC_DOMAIN, or HTTPS=true');
  }

  if (URL && !URL.startsWith('https://')) {
    warnings.push('URL should use HTTPS in production');
  }

  if (!DATABASE_URL && !REDIS_URL && !process.env.REDIS_PASSWORD) {
    warnings.push('No external database URL configured, using local Redis');
  }

  if (CORS_ALLOWED_ORIGINS) {
    if (CORS_ALLOWED_ORIGINS.includes('localhost') || CORS_ALLOWED_ORIGINS.includes('*')) {
      warnings.push('CORS allows localhost or wildcard origins in production');
    }
  } else {
    warnings.push('CORS_ALLOWED_ORIGINS not set, will block all cross-origin requests');
  }

  validateDatabaseUrls(errors);
}

function validateDatabaseUrls(errors: string[]): void {
  const urls = [
    process.env.DATABASE_URL,
    process.env.REDIS_URL,
    process.env.ARCHIVE_REDIS_URL
  ].filter(Boolean);

  for (const url of urls) {
    try {
      new URL(url!);
    } catch {
      errors.push(`Invalid database URL format: ${url}`);
    }
  }
}

export function enforceHTTPS(): void {
  const env = process.env.NODE_ENV;
  if (env === 'production' && !process.env.HTTPS) {
    console.error('❌ HTTPS must be enabled in production');
    exit(1);
  }
}