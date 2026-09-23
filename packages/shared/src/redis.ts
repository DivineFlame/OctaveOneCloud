/** Converts a redis:// or rediss:// URL into ioredis/BullMQ connection options. */
export function redisOptionsFromUrl(url: string) {
  const u = new URL(url);
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') throw new Error('REDIS_URL must use redis:// or rediss://');
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 6379,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}
