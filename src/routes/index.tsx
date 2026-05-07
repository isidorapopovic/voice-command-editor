import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Voice Video Editor — Edit videos with your voice" },
      {
        name: "description",
        content:
          "Upload a video and edit it by speaking. Trim, cut, and add text using natural language.",
      },
    ],
  }),
  component: Landing,
});

function Landing() {
  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center px-6 text-center"
      style={{ backgroundColor: "#2596be", color: "#fffef2" }}
    >
      <h1 className="max-w-3xl text-4xl font-bold leading-tight md:text-6xl">
        Voice Video Editor
      </h1>
      <p className="mt-4 max-w-xl text-lg opacity-90 md:text-xl">
        Upload a video. Speak your edits. We trim, cut and add text for you.
      </p>
      <Link
        to="/editor"
        className="mt-10 inline-flex items-center justify-center rounded-md px-8 py-3 text-base font-semibold transition-opacity hover:opacity-90"
        style={{ backgroundColor: "#fffef2", color: "#000" }}
      >
        Select video / audio
      </Link>
      <p className="mt-8 text-sm opacity-75">
        Example: "Cut the first 5 seconds and add the text Hello at the top"
      </p>
    </div>
  );
}
