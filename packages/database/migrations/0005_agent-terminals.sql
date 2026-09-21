CREATE TABLE `agent_terminals` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`purpose` text NOT NULL,
	`provider_id` text,
	`label` text NOT NULL,
	`model_id` text,
	`reasoning_effort` text,
	`permission_mode` text,
	`working_directory` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_terminals_workspace` ON `agent_terminals` (`workspace_id`);