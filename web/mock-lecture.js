// Scripted lecture used in demo mode (no microphone / speech-to-text needed).
// `after` = seconds of silence before the line starts.
// `gist` / `priority` are only used by the MOCK summarizer to fake a realistic
// catch-up card; the real summarizer (summarizer.py) only sees the text.
// Math uses \( \) and \[ \], the same delimiters summarizer.py produces.
window.Blink = window.Blink || {};

Blink.MOCK_LECTURE = [
  { after: 0.5, text: "Okay everyone, let's get started. Today we're finishing the chain rule.",
    gist: "Today's topic: finishing the chain rule" },
  { after: 1.5, text: "Quick reminder: the derivative of \\(e^x\\) is just \\(e^x\\), that's the whole point of \\(e\\).",
    gist: "The derivative of \\(e^x\\) is \\(e^x\\)" },
  { after: 1.5, text: "So if you have \\(e^{2x}\\), you use the chain rule and you get \\(2e^{2x}\\).",
    gist: "Chain rule on \\(e^{2x}\\) gives \\(2e^{2x}\\)" },
  { after: 1.5, text: "Here's the rule itself: \\[\\frac{d}{dx} f(g(x)) = f'(g(x))\\,g'(x)\\]",
    gist: "Chain rule: \\(\\frac{d}{dx} f(g(x)) = f'(g(x))\\,g'(x)\\)" },
  { after: 1.5, text: "In words: differentiate the outside, keep the inside, then multiply by the derivative of the inside.",
    gist: "Outside derivative × inside derivative" },
  { after: 1.5, text: "Let's try \\(\\sin(x^2)\\). The outside is sine, the inside is \\(x^2\\).",
    gist: "Example: \\(\\sin(x^2)\\)" },
  { after: 1.5, text: "So the derivative is \\(\\cos(x^2) \\cdot 2x\\).",
    gist: "\\(\\frac{d}{dx}\\sin(x^2) = 2x\\cos(x^2)\\)" },
  { after: 2.0, text: "Change of plans for the problem set: it's now due Friday at 9am, not Monday.",
    priority: "Problem set now due Friday 9am (not Monday)" },
  { after: 1.5, text: "And please submit it on the course website, not by email.",
    priority: "Submit the problem set on the course website, not by email" },
  { after: 2.0, text: "Andrea, what would the inside function be for \\(\\ln(3x+1)\\)?",
    priority: "Prof is asking you: what is the inside function of \\(\\ln(3x+1)\\)?" },
  { after: 1.5, text: "Take your time, I'll come back to you in a minute.",
    gist: "Prof will come back to you for the answer" },
  { after: 1.5, text: "Meanwhile, a very common mistake is forgetting to multiply by the inner derivative.",
    gist: "Common mistake: forgetting the inner derivative" },
  { after: 1.5, text: "For \\((3x+1)^5\\) you get \\(5(3x+1)^4 \\cdot 3\\), not just \\(5(3x+1)^4\\).",
    gist: "\\(\\frac{d}{dx}(3x+1)^5 = 15(3x+1)^4\\)" },
  { after: 2.0, text: "We voted last week, so the midterm will be open book, with one page of notes allowed.",
    priority: "Midterm is open book, one page of notes allowed" },
  { after: 2.0, text: "Next up, implicit differentiation, which is really just the chain rule in disguise.",
    gist: "Next topic: implicit differentiation" },
  { after: 1.5, text: "Take the circle \\(x^2 + y^2 = 25\\) and differentiate both sides with respect to \\(x\\).",
    gist: "Example: circle \\(x^2 + y^2 = 25\\)" },
  { after: 1.5, text: "You get \\(2x + 2y\\,\\frac{dy}{dx} = 0\\), so \\(\\frac{dy}{dx} = -\\frac{x}{y}\\).",
    gist: "\\(\\frac{dy}{dx} = -\\frac{x}{y}\\) on the circle" },
  { after: 1.5, text: "That's the slope of the tangent line at any point on the circle.",
    gist: "That's the tangent slope at any point" },
  { after: 2.0, text: "Okay, that's it for new material today. See you on Thursday.",
    gist: "End of new material" },
];
