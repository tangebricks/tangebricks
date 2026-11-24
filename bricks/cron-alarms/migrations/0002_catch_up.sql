-- cron-alarms 0002: Add catchUp and maxCatchUp columns for missed-run policy.
-- Defaults: catch_up = 'once' (single catch-up run), max_catch_up = 10.
ALTER TABLE cron_schedules ADD COLUMN catch_up TEXT NOT NULL DEFAULT 'once' CHECK (catch_up IN ('skip', 'once', 'all'));
ALTER TABLE cron_schedules ADD COLUMN max_catch_up INTEGER NOT NULL DEFAULT 10 CHECK (max_catch_up >= 1 AND max_catch_up <= 100);
