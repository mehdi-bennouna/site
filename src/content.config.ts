import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// Each entry lives in its own folder (`<slug>/index.md`) so it can keep its images next to it.
// The folder name is the entry id and URL slug.
function folderEntries(base: string) {
	return glob({
		pattern: "*/index.md",
		base,
		generateId: ({ entry }) => entry.split("/")[0],
	});
}

const blog = defineCollection({
	loader: folderEntries("./src/content/blog"),
	schema: z.object({
		title: z.string(),
		description: z.string(),
		date: z.coerce.date(),
		tags: z.array(z.string()).default([]),
		draft: z.boolean().optional().default(false),
		ogImage: z.string().optional(),
	}),
});

export const collections = { blog };
