const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'medify',
  password: 'dbms2327',
  port: 5432
});

module.exports = pool;
