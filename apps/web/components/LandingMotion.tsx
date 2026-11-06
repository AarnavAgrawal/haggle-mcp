"use client";

import { useEffect } from "react";

/** Where the reading line sits in the window: the log entry that has crossed it is the current step. */
const READ_LINE = 0.58;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * The landing page's scroll state. Renders nothing: it writes attributes and CSS variables and
 * app/landing.css does all the drawing, so the page itself stays a server component.
 *   --p        0 to 1: the sheet rising out of the hero and settling into its column
 *   --shift    how far the sheet sits from its column while it is centered under the wordmark
 *   data-step  which log entry the deal has reached (.at-N for every step reached, so CSS can gate on it)
 *   --log-p    how far down the log the reader is
 * Also marks the current section in the top bar and reveals [data-reveal] blocks as they arrive.
 */
export function LandingMotion() {
  useEffect(() => {
    const page = document.querySelector<HTMLElement>(".lp-page");
    const deal = page?.querySelector<HTMLElement>(".deal");
    const grid = page?.querySelector<HTMLElement>(".deal-grid");
    const stage = page?.querySelector<HTMLElement>(".deal-stage");
    const bar = page?.querySelector<HTMLElement>(".lp-bar");
    const wordmark = page?.querySelector<HTMLElement>(".lp-wordmark");
    if (!page || !deal || !grid || !stage || !bar || !wordmark) return;

    const rows = [...deal.querySelectorAll<HTMLElement>(".log-row")];
    const spy = [...bar.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')].map((link) => ({
      link,
      section: document.querySelector<HTMLElement>(link.hash),
    }));

    let travel = 1;
    const measure = () => {
      const stickyTop = parseFloat(getComputedStyle(stage).top) || 0;
      travel = Math.max(1, grid.getBoundingClientRect().top + window.scrollY - stickyTop);
      const box = stage.getBoundingClientRect();
      page.style.setProperty("--shift", `${document.documentElement.clientWidth / 2 - (box.left + box.width / 2)}px`);
    };

    let step = -1;
    const setStep = (next: number) => {
      if (next === step) return;
      step = next;
      deal.dataset.step = String(next);
      rows.forEach((row, i) => {
        row.classList.toggle("is-now", i === next);
        row.classList.toggle("is-past", i < next);
        deal.classList.toggle(`at-${i}`, i <= next);
      });
    };

    let frame = 0;
    const update = () => {
      frame = 0;
      const y = window.scrollY;
      const line = window.innerHeight * READ_LINE;

      page.style.setProperty("--p", clamp01(y / travel).toFixed(4));
      bar.toggleAttribute("data-top", wordmark.getBoundingClientRect().bottom > bar.offsetHeight);

      let reached = 0;
      rows.forEach((row, i) => {
        if (row.getBoundingClientRect().top < line) reached = i;
      });
      setStep(reached);
      const first = rows[0]!.getBoundingClientRect().top;
      const last = rows[rows.length - 1]!.getBoundingClientRect().top;
      deal.style.setProperty("--log-p", clamp01((line - first) / Math.max(1, last - first)).toFixed(4));

      let current: HTMLAnchorElement | null = null;
      for (const { link, section } of spy) {
        if (section && section.getBoundingClientRect().top < line) current = link;
      }
      for (const { link } of spy) {
        if (link === current) link.setAttribute("aria-current", "true");
        else link.removeAttribute("aria-current");
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = () => {
      measure();
      schedule();
    };

    // Reveals are armed here rather than in the markup, so a page whose script never ran shows everything.
    page.classList.add("is-live");
    const reveal = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          reveal.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    page.querySelectorAll("[data-reveal]").forEach((el) => reveal.observe(el));

    measure();
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", resize);
    // Webfonts change the hero's height, and with it how far the sheet has to travel.
    void document.fonts?.ready.then(resize);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", resize);
      reveal.disconnect();
    };
  }, []);

  return null;
}
