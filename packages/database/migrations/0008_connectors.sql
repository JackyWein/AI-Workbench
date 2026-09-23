ALTER TABLE `mcp_servers` ADD `availability` text DEFAULT 'everywhere' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `workspace_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `catalog_id` text;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `oauth` text;
