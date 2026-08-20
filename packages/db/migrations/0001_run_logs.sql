CREATE TABLE `run_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`ts` integer NOT NULL,
	`level` text NOT NULL,
	`msg` text NOT NULL,
	`video_id` text,
	`channel_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_logs_run` ON `run_logs` (`run_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_logs_level` ON `run_logs` (`run_id`,`level`);