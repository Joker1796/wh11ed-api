-- How the site performs on the phones it runs on, from the visitors who switched error sending on
-- (the same consent, the same POST /errors — domain/clientErrors.ts). Aggregates, never events: one
-- row per day, site, version, screen, browser family and device class, counted up. No IP, no
-- account; the screen is the router's route pattern ("/roster/:id"), never an address.
--
-- inp_hist: sessions on that screen by their slowest tap-to-paint, in buckets
-- [<100, <200, <500, <1000, >=1000] ms (a session with no tap is not in it).

CREATE TABLE client_perf (
  day          date NOT NULL,
  channel      text NOT NULL,              -- 'prod' | 'beta'
  app_version  text NOT NULL,
  route        text NOT NULL,              -- the route pattern
  browser      text NOT NULL,              -- domain/clientErrors.ts browserOf: "Chrome Android"
  device       text NOT NULL,              -- "c8m4": logical cores, device memory GB (0 = unknown)
  sessions     integer NOT NULL DEFAULT 0, -- page sessions on that screen
  seconds      bigint NOT NULL DEFAULT 0,  -- time on it, visible
  inp_hist     jsonb NOT NULL DEFAULT '[0,0,0,0,0]',
  long_n       bigint NOT NULL DEFAULT 0,  -- long tasks (>50 ms)
  long_ms      bigint NOT NULL DEFAULT 0,  -- their total length
  PRIMARY KEY (day, channel, app_version, route, browser, device)
);
CREATE INDEX idx_client_perf_day ON client_perf (day);
