// document.getElementById("toggleMode").addEventListener("click", () => {
//   document.body.classList.toggle("dark-mode");
// });


// Check for saved dark mode preference
const darkMode = localStorage.getItem('darkMode');

// Get toggle button
const darkModeToggle = document.getElementById("toggleMode");

// Function to enable dark mode
const enableDarkMode = () => {
  document.body.classList.add("dark-mode");
  localStorage.setItem('darkMode', 'enabled');
  darkModeToggle.textContent = '☀️ Light Mode';
};

// Function to disable dark mode
const disableDarkMode = () => {
  document.body.classList.remove("dark-mode");
  localStorage.setItem('darkMode', null);
  darkModeToggle.textContent = '🌙 Dark Mode';
};

// Set initial state
if (darkMode === 'enabled') {
  enableDarkMode();
} else {
  disableDarkMode();
}

// Handle toggle clicks
darkModeToggle.addEventListener("click", () => {
  const darkMode = localStorage.getItem('darkMode');
  if (darkMode !== 'enabled') {
    enableDarkMode();
  } else {
    disableDarkMode();
  }
});