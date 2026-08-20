ALTER TABLE `channels` ADD `joined_at` integer;--> statement-breakpoint
ALTER TABLE `videos` ADD `channel_hit_rate` real;--> statement-breakpoint
ALTER TABLE `videos` ADD `channel_age_days` real;
