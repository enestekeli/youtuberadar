ALTER TABLE `videos` ADD `seed_query` text;
--> statement-breakpoint
ALTER TABLE `videos` ADD `topic_score` real;
--> statement-breakpoint
ALTER TABLE `videos` ADD `topic_matches_json` text;
