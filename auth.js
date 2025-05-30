async function checkPin() {
  let attempts = parseInt(sessionStorage.getItem("pin_attempts") || "0");

  if (attempts >= 4) {
    alert("Maximum attempts exceeded. Access denied.");
    document.body.innerHTML = "<h2 style='text-align:center;color:red;'>Access Denied</h2>";
    return;
  }

  const pin = prompt(`Enter PIN to access this site:\n(Attempt ${attempts + 1} of 4)`);

  if (!pin) {
    alert("PIN is required.");
    sessionStorage.setItem("pin_attempts", attempts + 1);
    location.reload();
    return;
  }

  const endpoint = "YOUR_WEB_APP_URL_HERE"; // Replace with your deployed Apps Script URL
  const res = await fetch(endpoint, {
    method: "POST",
    body: new URLSearchParams({ pin })
  });

  const result = await res.json();

  if (result.status === "success") {
    sessionStorage.setItem("access_granted", "true");
    sessionStorage.removeItem("pin_attempts");
    console.log(`Welcome ${result.name}`);
  } else {
    sessionStorage.setItem("pin_attempts", attempts + 1);
    alert("Invalid PIN.");
    location.reload();
  }
}

// Run check only if not already granted
if (sessionStorage.getItem("access_granted") !== "true") {
  checkPin();
}
