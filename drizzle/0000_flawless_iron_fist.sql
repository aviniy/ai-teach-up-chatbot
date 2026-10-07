CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`mode` text NOT NULL,
	`turns_used` integer DEFAULT 0 NOT NULL,
	`chars_used` integer DEFAULT 0 NOT NULL,
	`bonus_turns` integer DEFAULT 0 NOT NULL,
	`bonus_chars` integer DEFAULT 0 NOT NULL,
	`messages` text DEFAULT '[]' NOT NULL,
	`pending` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_updated_at` ON `sessions` (`updated_at`);