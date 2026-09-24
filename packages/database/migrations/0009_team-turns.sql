CREATE TABLE `team_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`task_id` text,
	`status` text NOT NULL,
	`output` text DEFAULT '' NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `team_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_turns_run_idx` ON `team_turns` (`run_id`);
