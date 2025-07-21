const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const { Pool } = require('pg');
const logger = require('./logger'); // Import Winston logger
const koaMorgan = require('koa-morgan'); // ✅ Use koa-morgan for logging
const { connect } = require('nats'); // Import NATS client

// NATS Connection
let nc;
const NATS_URL = process.env.NATS_URL || 'nats://nats-server:4222'; // Default NATS URL

async function connectNATS() {
  try {
    nc = await connect({ servers: NATS_URL });
    logger.info(`Connected to NATS at ${NATS_URL}`);
    nc.closed().then(() => {
      logger.info('NATS connection closed.');
    });
  } catch (err) {
    logger.error(`Error connecting to NATS: ${err.message}`);
    // Optionally exit or retry based on application requirements
  }
}

// Create a PostgreSQL connection pool using environment variables
if (!process.env.POSTGRES_USER || !process.env.POSTGRES_PASSWORD || !process.env.POSTGRES_HOST || !process.env.POSTGRES_DB) {
  logger.error('Missing required environment variables for PostgreSQL connection.');
  process.exit(1);
}

const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: process.env.POSTGRES_PORT || 5432,
});

const app = new Koa();
const router = new Router();
const PORT = process.env.PORT || 3001;

app.use(async (ctx, next) => {
  logger.info(`Received request: ${ctx.method} ${ctx.url}`);
  await next();
});

app.use(cors());

// ✅ Use koa-morgan instead of morgan
app.use(koaMorgan('combined', {
  stream: { write: (message) => logger.info(message.trim()) }
}));

app.use(bodyParser());

// ✅ Ensure the todos table exists and has the 'done' column
const ensureTodosTableExists = async () => {
  try {
    // First, create the table if it doesn't exist, now with the 'done' column.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS todos (
        id SERIAL PRIMARY KEY,
        task TEXT NOT NULL,
        done BOOLEAN DEFAULT false
      );
    `);

    // Then, check if the 'done' column exists and add it if it doesn't.
    // This handles migrations for existing tables.
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='todos' and column_name='done'
    `);

    if (columnCheck.rows.length === 0) {
      logger.info('Migrating table: adding "done" column to todos.');
      await pool.query('ALTER TABLE todos ADD COLUMN done BOOLEAN DEFAULT false');
    }

    const res = await pool.query('SELECT * FROM todos');
    if (res.rows.length === 0) {
      logger.info('No todos found. Initializing with default values...');
      await pool.query('INSERT INTO todos (task) VALUES ($1), ($2), ($3)', [
        'Buy groceries',
        'Read a book',
        'Exercise for 30 minutes',
      ]);
    } else {
      logger.info('Todos table already initialized.');
    }
  } catch (err) {
    logger.error('Error initializing the todos table:', err.message);
    process.exit(1);
  }
};

// ✅ GET `/` - Health check for Ingress (Always return 200 OK)

router.get('/', async (ctx) => {
  ctx.status = 200;
  ctx.body = 'OK';
  logger.info('✅ Health check: 200 OK');
});

// ✅ GET /todos - Fetch all todos
router.get('/todos', async (ctx) => {
  try {
    const result = await pool.query('SELECT id, task, done FROM todos ORDER BY id ASC');
    ctx.status = 200; // ✅ Ensure success response
    ctx.body = { todos: result.rows }; // Return the full objects
    logger.info('Fetched todos successfully');
  } catch (err) {
    logger.error('Error fetching todos:', err.message);
    ctx.status = 500;
    ctx.body = { error: 'Failed to fetch todos' };
  }
});

router.get('/healthz', async (ctx) => {
  try {
    await pool.query('SELECT 1');
    ctx.status = 200;
    ctx.body = 'DB Connected';
  } catch (err) {
    logger.error('❌ DB not reachable:', err.message);
    ctx.status = 500;
    ctx.body = 'DB Error';
  }
});

// ✅ POST /todos - Add a new todo
router.post('/todos', async (ctx) => {
  const newTodo = ctx.request.body.todo;

  // Validate the todo
  if (!newTodo || typeof newTodo !== 'string' || newTodo.trim().length === 0) {
    logger.warn(`Invalid todo attempt: Empty or non-string value`);
    ctx.status = 400;
    ctx.body = { error: 'Invalid todo. Must be a non-empty string.' };
    return;
  }

  if (newTodo.length > 140) {
    logger.warn(`Invalid todo attempt: Todo exceeds 140 characters - "${newTodo}"`);
    ctx.status = 400;
    ctx.body = { error: 'Invalid todo. Must be a string with less than 140 characters.' };
    return;
  }

  try {
    const trimmedTodo = newTodo.trim();
    await pool.query('INSERT INTO todos (task) VALUES ($1)', [trimmedTodo]);
    const result = await pool.query('SELECT id, task, done FROM todos ORDER BY id ASC');

    ctx.status = 201;
    ctx.body = { message: 'Todo created', todos: result.rows };
    logger.info(`Todo created: "${trimmedTodo}"`);

    // Publish to NATS
    if (nc) {
      const createdTodo = result.rows.find(t => t.task === trimmedTodo);
      if (createdTodo) {
        nc.publish('todos.events', JSON.stringify({ eventType: 'created', todo: createdTodo }));
        logger.info(`Published 'created' event for todo ${createdTodo.id} to NATS`);
      }
    }
  } catch (err) {
    logger.error('Error adding todo:', err.message);
    ctx.status = 500;
    ctx.body = { error: 'Failed to add todo' };
  }
});

// ✅ PUT /todos/:id - Mark a todo as done or not done
router.put('/todos/:id', async (ctx) => {
  const { id } = ctx.params;
  const { done } = ctx.request.body;

  if (typeof done !== 'boolean') {
    ctx.status = 400;
    ctx.body = { error: 'Invalid payload. "done" must be a boolean.' };
    return;
  }

  try {
    const result = await pool.query(
      'UPDATE todos SET done = $1 WHERE id = $2 RETURNING *',
      [done, id]
    );

    if (result.rowCount === 0) {
      ctx.status = 404;
      ctx.body = { error: 'Todo not found' };
      return;
    }

    ctx.status = 200;
    ctx.body = { message: 'Todo updated', todo: result.rows[0] };
    logger.info(`Todo ${id} marked as ${done ? 'done' : 'not done'}`);

    // Publish to NATS
    if (nc) {
      nc.publish('todos.events', JSON.stringify({ eventType: 'updated', todo: result.rows[0] }));
      logger.info(`Published 'updated' event for todo ${id} to NATS`);
    }
  } catch (err) {
    logger.error(`Error updating todo ${id}:`, err.message);
    ctx.status = 500;
    ctx.body = { error: 'Failed to update todo' };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

// ✅ Initialize the app
const initializeApp = async () => {
  logger.info('Initializing app...');
  await ensureTodosTableExists();
  await connectNATS();
  app.listen(PORT, () => {
    logger.info(`Backend server is listening on port ${PORT}`);
  });
};

// ✅ Start the app
initializeApp().catch((err) => {
  logger.error('Failed to initialize the app:', err.message);
  process.exit(1);
});