// functions/_middleware.ts

class MetaTagInjector {
  private title: string;
  private description: string;

  constructor(title: string, description: string) {
    this.title = title;
    this.description = description;
  }

  element(element: HTMLElement) {
    if (element.tagName === "title") {
      element.setInnerContent(this.title);
    } else if (element.tagName === "meta") {
      const nameAttr = element.getAttribute("name");
      const ogAttr = element.getAttribute("property");

      if (nameAttr === "description" || ogAttr === "og:description") {
        element.setAttribute("content", this.description);
      }
      if (ogAttr === "og:title") {
        element.setAttribute("content", this.title);
      }
    }
  }
}

export const onRequest: PagesFunction = async (context) => {
  const response = await context.next();
  const url = new URL(context.request.url);

  // Define tailored SEO for your main organic landing pages
  let title = "ExplaiNote AI - Smart Quiz & Active Recall Note Generator";
  let description = "Convert uploaded documents and pasted text into active-recall flashcards, simplified summaries, and customized quizzes instantly with ExplaiNote AI.";

  if (url.pathname.startsWith("/quiz")) {
    title = "AI Quiz Generator - Create Quizzes from Any Document | ExplaiNote AI";
    description = "Instantly turn study materials, PDFs, or pasted text into interactive custom quizzes to test your knowledge.";
  } else if (url.pathname.startsWith("/recall")) {
    title = "Active Recall & Flashcard Generator | ExplaiNote AI";
    description = "Boost retention by automatically turning complex study materials into active recall notes and targeted flashcards.";
  }

  // Rewrite the HTML headers on the fly
  return new HTMLRewriter()
    .on("title", new MetaTagInjector(title, description))
    .on("meta[name='description']", new MetaTagInjector(title, description))
    .on("meta[property='og:title']", new MetaTagInjector(title, description))
    .on("meta[property='og:description']", new MetaTagInjector(title, description))
    .transform(response);
};
