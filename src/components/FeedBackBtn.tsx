import { useEffect, useState } from "react";

export default function TallyFeedbackButton({
  formId = "dWzxAK",
  buttonText = "Feedback",
}) {
  const [userIp, setUserIp] = useState("unknown");

  useEffect(() => {
    // 1. Fetch the public IP address from ipify
    fetch("https://api.ipify.org?format=json")
      .then((response) => response.json())
      .then((data) => {
        if (data && data.ip) {
          setUserIp(data.ip);
        }
      })
      .catch((error) => {
        console.error("Error fetching IP address:", error);
      });

    // 2. Load the Tally embed script
    const existingScript = document.querySelector(
      'script[src="https://tally.so/widgets/embed.js"]'
    );

    if (!existingScript) {
      const script = document.createElement("script");
      script.src = "https://tally.so/widgets/embed.js";
      script.async = true;
      document.body.appendChild(script);
    }
  }, []);

  const openTally = () => {
    if (window.Tally) {
      window.Tally.openPopup(formId, {
        layout: "modal",
        width: 700,
        overlay: true,
        emoji: {
          text: "👋",
          animation: "wave",
        },
        autoClose: 2000,
        // 3. Inject the fetched IP address into the 'source' hidden field
        hiddenFields: {
          source: userIp,
        },
      });
    }
  };

  return (
    <button
      onClick={openTally}
      aria-label="Send Feedback"
      className="feedback-fab"
    >
      <span className="feedback-fab__icon">💬</span>
      <span className="feedback-fab__text">{buttonText}</span>
    </button>
  );
}