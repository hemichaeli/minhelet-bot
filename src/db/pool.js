const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL;

let poolConfig;

if (dbUrl) {
  console.log(`[pool] Using DATABASE_URL (length=${dbUrl.length}): ${dbUrl.substring(0, 40)}...`);
  
  // Railway native Postgres and most managed DBs need SSL
  // Only disable SSL if explicitly set to 'false'
  const sslDisabled = process.env.DATABASE_SSL === 'false';
  
  poolConfig = {
    connectionString: dbUrl,
    ssl: sslDisabled ? false : { rejectUnauthorized: false },
  };
} else {
  const host = process.env.PGHOST || 'localhost';
  const port = parseInt(process.env.PGPORT || '5432');
  const database = process.env.PGDATABASE || 'pinuy_binuy';
  const user = process.env.PGUSER || 'pinuy_admin';
  const password = process.env.PGPASSWORD || 'pinuy_secure_2024';
  console.log(`[pool] Using individual params: ${user}@${host}:${port}/${database}`);
  poolConfig = { host, port, database, user, password, ssl: false };
}

console.log('[pool] Pool config keys:', Object.keys(poolConfig).join(', '));
console.log('[pool] SSL:', poolConfig.ssl ? 'enabled' : 'disabled');

const pool = new Pool({
  ...poolConfig,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected pool error:', err.message);
});

module.exports = pool;
