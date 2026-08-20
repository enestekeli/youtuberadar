CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `channels` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`handle` text,
	`subs_approx` integer,
	`subs_text` text,
	`subs_hidden` integer DEFAULT false NOT NULL,
	`uploads_json` text,
	`snapshot_fetched_at` integer,
	`verdict` text DEFAULT 'unknown' NOT NULL,
	`verdict_expires_at` integer,
	`fetch_error_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_channels_verdict` ON `channels` (`verdict`,`verdict_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_channels_updated` ON `channels` (`updated_at`);--> statement-breakpoint
CREATE TABLE `video_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`video_id` text NOT NULL,
	`channel_id` text,
	`depth` integer DEFAULT 0 NOT NULL,
	`stage` text NOT NULL,
	`verdict` text NOT NULL,
	`details_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_observation` ON `video_observations` (`run_id`,`video_id`);--> statement-breakpoint
CREATE INDEX `idx_obs_video` ON `video_observations` (`video_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_obs_created` ON `video_observations` (`created_at`);--> statement-breakpoint
CREATE TABLE `presets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`config_json` text NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `presets_name_unique` ON `presets` (`name`);--> statement-breakpoint
CREATE TABLE `runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`config_json` text NOT NULL,
	`stats_json` text,
	`stop_reason` text,
	`frontier_snapshot_json` text,
	`preset_id` integer,
	`app_version` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_runs_started` ON `runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `idx_runs_status` ON `runs` (`status`);--> statement-breakpoint
CREATE TABLE `exports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`video_id` text NOT NULL,
	`exported_at` integer NOT NULL,
	`destination` text NOT NULL,
	`destination_detail` text,
	`payload_version` text NOT NULL,
	`payload_json` text NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_exports_video` ON `exports` (`video_id`,`exported_at`);--> statement-breakpoint
CREATE TABLE `videos` (
	`video_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`title` text NOT NULL,
	`thumbnail_url` text,
	`duration_sec` integer NOT NULL,
	`views` integer NOT NULL,
	`vpd` real NOT NULL,
	`projected_views` real NOT NULL,
	`published_age_days` real NOT NULL,
	`score_type` text NOT NULL,
	`hype` real,
	`vsr` real,
	`z` real,
	`baseline_median` real,
	`baseline_n` integer,
	`baseline_samples_json` text,
	`low_confidence` integer DEFAULT false NOT NULL,
	`channel_is_hot` integer DEFAULT false NOT NULL,
	`suspected_bought_traffic` integer DEFAULT false NOT NULL,
	`channel_name` text,
	`subs_approx` integer,
	`subs_text` text,
	`subs_hidden` integer DEFAULT false NOT NULL,
	`depth` integer NOT NULL,
	`seed_video_id` text,
	`status` text DEFAULT 'pooled' NOT NULL,
	`status_changed_at` integer NOT NULL,
	`caught_at` integer NOT NULL,
	`description` text,
	`published_at` text,
	`likes` integer,
	`refreshed_at` integer,
	CONSTRAINT "videos_views_sane" CHECK("videos"."views" >= 0),
	CONSTRAINT "videos_score_present" CHECK("videos"."hype" IS NOT NULL OR "videos"."vsr" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `idx_videos_status_hype` ON `videos` (`status`,`hype`);--> statement-breakpoint
CREATE INDEX `idx_videos_status_caught` ON `videos` (`status`,`caught_at`);--> statement-breakpoint
CREATE INDEX `idx_videos_channel` ON `videos` (`channel_id`);--> statement-breakpoint
CREATE INDEX `idx_videos_run` ON `videos` (`run_id`);