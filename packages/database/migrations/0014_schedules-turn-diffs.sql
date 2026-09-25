CREATE TABLE `schedule_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`status` text NOT NULL,
	`schedule_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`session_id` text,
	`team_run_id` text,
	`due_at` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`turns` integer DEFAULT 0 NOT NULL,
	`tokens` integer,
	`error` text,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`content` text NOT NULL,
	`enabled` integer NOT NULL,
	`last_run_at` integer,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `chat_messages` ADD `turn_diff` text;
