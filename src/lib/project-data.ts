import type { ImageMetadata } from "astro";
import { getCollection, type CollectionEntry } from "astro:content";

export type ProjectEntry = CollectionEntry<"projects">;

// A project's thumbnail is the `thumbnail.png` file in its folder, if there is one.
const thumbnails = import.meta.glob<ImageMetadata>("/src/content/projects/*/thumbnail.png", {
	eager: true,
	import: "default",
});

function getThumbnail(slug: string): ImageMetadata | undefined {
	return thumbnails[`/src/content/projects/${slug}/thumbnail.png`];
}

export interface Project {
	slug: string;
	title: string;
	description: string;
	date: string;
	status?: "active" | "maintained" | "archived";
	tags: string[];
	repo?: string;
	url?: string;
	thumbnail?: ImageMetadata;
	thumbnailAlt: string;
	hasWriteup: boolean;
}

export function formatProject(entry: ProjectEntry): Project {
	const body = (entry as { body?: string }).body ?? "";

	return {
		slug: entry.id,
		title: entry.data.title,
		description: entry.data.description,
		date: entry.data.date.toISOString().slice(0, 10),
		status: entry.data.status,
		tags: entry.data.tags ?? [],
		repo: entry.data.repo,
		url: entry.data.url,
		thumbnail: getThumbnail(entry.id),
		thumbnailAlt: entry.data.thumbnailAlt ?? `${entry.data.title} screenshot`,
		hasWriteup: body.trim().length > 0,
	};
}

export async function getProjectEntries(): Promise<ProjectEntry[]> {
	const entries = await getCollection("projects", (entry) => !entry.data.draft);

	// Projects with an explicit order come first, then newest first.
	return entries.sort((a, b) => {
		const orderA = a.data.order ?? Infinity;
		const orderB = b.data.order ?? Infinity;
		if (orderA !== orderB) return orderA - orderB;
		return b.data.date.getTime() - a.data.date.getTime();
	});
}

export async function getProjects(): Promise<Project[]> {
	return (await getProjectEntries()).map(formatProject);
}
