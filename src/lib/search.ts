export type Article = {
	slug: string;
	title: string;
	date: string;
	excerpt: string;
	tags: string[];
	wordCount?: number;
	readMinutes?: number;
};

export interface IndexedArticle<T extends Article = Article> {
	article: T;
	searchableContent: string;
	tokens: Set<string>;
	dateTime: number;
	lowerTitle: string;
	lowerExcerpt: string;
	lowerSlug: string;
	lowerTags: string[];
}

const MONTH_NAMES = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

const MONTH_SHORT_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function getSearchableContent(article: Article): string {
	if (!article) return "";
	const dateStr = article.date ? String(article.date) : "";
	const d = new Date(dateStr);
	const isValidDate = !isNaN(d.getTime());

	let dateParts: string[] = [];
	if (isValidDate) {
		const year = d.getUTCFullYear().toString();
		const month = d.getUTCMonth();
		const day = d.getUTCDate().toString();
		const isoDate = dateStr.slice(0, 10);
		dateParts = [year, MONTH_NAMES[month] ?? "", MONTH_SHORT_NAMES[month] ?? "", day, isoDate];
	} else if (dateStr) {
		dateParts = [dateStr];
	}

	const slugParts = article.slug ? String(article.slug).replace(/[-_/]/g, " ") : "";
	const tags = Array.isArray(article.tags) ? article.tags : [];
	const tagParts = tags.flatMap((t) => {
		const str = String(t ?? "");
		return [str, str.replace(/[-_/]/g, " ")];
	});

	return [article.title ? String(article.title) : "", article.excerpt ? String(article.excerpt) : "", slugParts, ...tagParts, ...dateParts]
		.join(" ")
		.toLowerCase();
}

const articleIndexCache = new WeakMap<Article, IndexedArticle<any>>();

export function indexArticle<T extends Article>(article: T): IndexedArticle<T> {
	const cached = articleIndexCache.get(article);
	if (cached) return cached as IndexedArticle<T>;

	const searchableContent = getSearchableContent(article);
	const words = searchableContent.split(/\s+/).filter(Boolean);
	const tokens = new Set(words);
	const d = new Date(article?.date || 0);
	const dateTime = isNaN(d.getTime()) ? 0 : d.getTime();

	const indexed: IndexedArticle<T> = {
		article,
		searchableContent,
		tokens,
		dateTime,
		lowerTitle: String(article?.title || "").toLowerCase(),
		lowerExcerpt: String(article?.excerpt || "").toLowerCase(),
		lowerSlug: String(article?.slug || "")
			.toLowerCase()
			.replace(/[-_/]/g, " "),
		lowerTags: (Array.isArray(article?.tags) ? article.tags : []).map((t) => String(t || "").toLowerCase()),
	};

	articleIndexCache.set(article, indexed);
	return indexed;
}

export function indexArticles<T extends Article>(articles: T[]): IndexedArticle<T>[] {
	if (!Array.isArray(articles)) return [];
	return articles.filter(Boolean).map(indexArticle);
}

export function searchArticles<T extends Article>(articles: T[], query?: string): T[] {
	if (!articles || !Array.isArray(articles) || articles.length === 0) return [];

	const trimmed = typeof query === "string" ? query.trim().toLowerCase() : "";
	if (!trimmed) {
		return [...articles].sort((a, b) => {
			const timeA = new Date(a?.date || 0).getTime() || 0;
			const timeB = new Date(b?.date || 0).getTime() || 0;
			return timeB - timeA;
		});
	}

	const queryTokens = trimmed.split(/\s+/).filter(Boolean);
	const indexedList = indexArticles(articles);
	const matched: { article: T; score: number; dateTime: number }[] = [];

	for (const item of indexedList) {
		const { article, searchableContent, dateTime, lowerTitle, lowerExcerpt, lowerSlug, lowerTags } = item;

		let allTokensMatch = true;
		let score = 0;

		if (lowerTitle === trimmed) {
			score += 100;
		} else if (lowerTitle.includes(trimmed)) {
			score += 60;
		}

		for (const token of queryTokens) {
			if (!searchableContent.includes(token)) {
				allTokensMatch = false;
				break;
			}
			if (lowerTitle.includes(token)) {
				score += 25;
			}
			if (lowerTags.some((t) => t === token || t.includes(token))) {
				score += 20;
			}
			if (lowerSlug.includes(token)) {
				score += 10;
			}
			if (lowerExcerpt.includes(token)) {
				score += 5;
			}
		}

		if (allTokensMatch) {
			matched.push({ article, score, dateTime });
		}
	}

	matched.sort((a, b) => {
		if (b.score !== a.score) {
			return b.score - a.score;
		}
		return b.dateTime - a.dateTime;
	});

	return matched.map((m) => m.article);
}

export const filterArticles = searchArticles;
