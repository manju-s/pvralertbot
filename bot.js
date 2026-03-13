// Load environment variables from a .env file
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs/promises'); // Using the promises version of the file system module

// Get the Telegram Bot Token from the .env file
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
    console.error("TELEGRAM_BOT_TOKEN not found! Please add it to your .env file.");
    process.exit(1);
}

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, { polling: true });

console.log("Bot started and is listening for messages...");

// --- API Configuration ---
const PVR_API_BASE_URL = 'https://api3.pvrcinemas.com/api/v1/booking/content';
const PVR_API_HEADERS = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-IN,en;q=0.9',
    'appversion': '1.0',
    'authorization': 'Bearer',
    'chain': 'PVR',
    'city': 'Bengaluru',
    'content-type': 'application/json',
    'country': 'INDIA',
    'origin': 'https://www.pvrcinemas.com',
    'platform': 'WEBSITE',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
};

// A simple in-memory store to manage user conversation states
const userStates = {};

// --- Persistent Alert Storage ---
const ALERTS_FILE_PATH = 'activeAlerts.json';
let activeAlerts = {}; // Changed to 'let' to allow it to be reassigned on load

/**
 * Saves the current state of activeAlerts to a JSON file.
 */
async function saveAlertsToFile() {
    try {
        await fs.writeFile(ALERTS_FILE_PATH, JSON.stringify(activeAlerts, null, 2), 'utf8');
    } catch (error) {
        console.error("Error saving alerts to file:", error);
    }
}

/**
 * Loads alerts from the JSON file into memory when the bot starts.
 */
async function loadAlertsFromFile() {
    try {
        const data = await fs.readFile(ALERTS_FILE_PATH, 'utf8');
        activeAlerts = JSON.parse(data);
        console.log(`✅ Successfully loaded alerts for ${Object.keys(activeAlerts).length} users from ${ALERTS_FILE_PATH}.`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log("`activeAlerts.json` not found. Starting fresh. The file will be created when the first alert is set.");
        } else {
            console.error("Error loading alerts from file:", error);
        }
    }
}


/**
 * Fetches the list of 'Now Showing' movies from the PVR API and checks for a specific movie.
 * @param {string} movieName - The name of the movie to search for.
 * @returns {Promise<object|null>} - The movie object if found, otherwise null.
 */
async function findMovie(movieName) {
    try {
        const response = await axios.post(`${PVR_API_BASE_URL}/nowshowing`, { city: 'Bengaluru' }, { headers: PVR_API_HEADERS });
        const movies = response.data.output.mv;

        if (!movies || !Array.isArray(movies)) {
            console.error("Could not find a valid movie array in the API response.");
            return null;
        }

        const searchTerm = movieName.toLowerCase().trim();
        const foundMovie = movies.find(movie =>
            movie.filmName.toLowerCase().includes(searchTerm) && movie.movieType === 'NOWSHOWING'
        );

        return foundMovie || null;

    } catch (error) {
        console.error("Error in findMovie:", error.response ? error.response.status : error.message);
        return null;
    }
}

/**
 * Fetches the list of 'Coming Soon' movies from the PVR API.
 * @param {string} movieName - The name of the movie to search for.
 * @returns {Promise<object|null>} - The movie object if found, otherwise null.
 */
async function findComingSoonMovie(movieName) {
    try {
        const response = await axios.post(`${PVR_API_BASE_URL}/comingsoon`, { city: 'Bengaluru', genres: "", languages: "" }, { headers: PVR_API_HEADERS });
        const movies = response.data.output.movies;

        if (!movies || !Array.isArray(movies)) {
            console.error("Could not find a valid movie array in the coming soon API response.");
            return null;
        }

        const searchTerm = movieName.toLowerCase().trim();
        const foundMovie = movies.find(movie =>
            movie.filmName.toLowerCase().includes(searchTerm) && movie.movieType === 'UPCOMING'
        );

        return foundMovie || null;

    } catch (error) {
        console.error("Error in findComingSoonMovie:", error.response ? error.response.status : error.message);
        return null;
    }
}

/**
 * Fetches movie sessions for a given movie ID and filters them by date and cinema.
 * @param {string} movieId - The ID of the movie.
 * @param {string} targetDate - The date to search for (YYYY-MM-DD).
 * @param {string} targetCinema - The name of the cinema to search for.
 * @param {string} city - The city to search in.
 * @returns {Promise<object|null>} - An object with cinema details and showtimes, or null if not found.
 */
async function findShowtimes(movieId, targetDate, targetCinema, city = 'Bengaluru') {
    const requestBody = {
        city: city,
        mid: movieId,
        experience: "ALL", specialTag: "ALL", lat: "12.915336", lng: "77.373046",
        lang: "ALL", format: "ALL", dated: targetDate ? targetDate : new Date().toISOString().slice(0, 10), time: "08:00-24:00",
        cinetype: "ALL", hc: "ALL", adFree: false
    };

    const headers = { ...PVR_API_HEADERS, city: city };

    try {
        const response = await axios.post(`${PVR_API_BASE_URL}/msessions`, requestBody, { headers: headers });
        const sessions = response.data?.output?.movieCinemaSessions;
        if (!sessions || !Array.isArray(sessions)) {
            return { error: 'no_shows_on_date' };
        }

        const targetCinemaLower = targetCinema.toLowerCase().trim();
        const relevantShows = [];
        const cinemaData = sessions.find(s => s.cinema.name.toLowerCase().includes(targetCinemaLower));

        if (!cinemaData) {
            return { error: 'cinema_not_found' };
        }

        cinemaData?.experienceSessions?.forEach(exp => {
            exp.shows.forEach(show => {
                if (show.showDateStr === targetDate) {
                    relevantShows.push(show.showTime);
                }
            });
        });

        if (relevantShows.length === 0) {
            return { error: 'no_shows_on_date' };
        }

        return {
            cinemaName: cinemaData.cinema.name,
            showtimes: relevantShows.sort()
        };

    } catch (error) {
        console.error("Error in findShowtimes:", error.response ? error.response.status : error.message);
        return null;
    }
}

// Main message listener to handle conversations and general messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || text.startsWith('/')) {
        return;
    }

    if (userStates[chatId] && userStates[chatId].action === 'awaiting_showtime_details') {
        const [city, date, ...cinemaParts] = text.split(',');
        const cinemaName = cinemaParts.join(',').trim();

        if (!city || !date || !cinemaName) {
            bot.sendMessage(chatId, "❌ Invalid format. Please provide the City, Date and Cinema Name separated by commas.\n\nExample: `Bengaluru, 2025-09-23, PVR Global Mall`", { parse_mode: 'Markdown' });
            return;
        }

        const { movieId, movieName } = userStates[chatId];
        const trimmedCity = city.trim();
        const trimmedDate = date.trim();
        bot.sendMessage(chatId, `Checking showtimes for *${movieName}* at *${cinemaName}* in *${trimmedCity}* on *${trimmedDate}*...`, { parse_mode: 'Markdown' });

        const showtimesResult = await findShowtimes(movieId, trimmedDate, cinemaName, trimmedCity);

        if (showtimesResult && !showtimesResult.error) {
            const message = `✅ Found shows for *${showtimesResult.cinemaName}* in *${trimmedCity}* on *${trimmedDate}*:\n\nShowtimes: \`${showtimesResult.showtimes.join(' | ')}\``;
            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            delete userStates[chatId];
        } else if (showtimesResult && showtimesResult.error === 'cinema_not_found') {
            bot.sendMessage(chatId, `😔 Sorry, I couldn't find any cinema matching "${cinemaName}". Please check the spelling.`);
            delete userStates[chatId];
        } else if (showtimesResult && showtimesResult.error === 'no_shows_on_date') {
            userStates[chatId].action = 'awaiting_alert_confirmation';
            userStates[chatId].date = trimmedDate;
            userStates[chatId].cinemaName = cinemaName;
            userStates[chatId].city = trimmedCity;

            const options = {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔔 Yes, set an alert', callback_data: 'confirm_alert' }],
                        [{ text: '❌ No, thanks', callback_data: 'cancel_alert' }]
                    ]
                }
            };
            bot.sendMessage(chatId, `😔 No shows found for *${movieName}* at "${cinemaName}" in ${trimmedCity} on ${trimmedDate}.\n\nWould you like me to notify you if tickets become available?`, options);
        } else {
            bot.sendMessage(chatId, "😥 Something went wrong while fetching showtimes. Please try again later.");
            delete userStates[chatId];
        }
        return;
    }
});

// Listen for the /start or /help command for a welcome message
bot.onText(/\/start|\/help/, (msg) => {
    const chatId = msg.chat.id;
    const welcomeMessage = `Welcome to the Movie Ticket Alert Bot! 👋

Here's how to use me:
• Check for a movie: \`/check <movie name>\`
  (e.g., \`/check Fighter\`)

• See your active alerts: \`/myalerts\`
    `;
    bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});


// Listen for the /check command
bot.onText(/\/check (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const movieNameToSearch = match[1];

    if (!movieNameToSearch) {
        bot.sendMessage(chatId, "Please provide a movie name after the /check command.");
        return;
    }

    await bot.sendMessage(chatId, `🔍 Searching for "${movieNameToSearch}" in Bengaluru...`);

    const movieResult = await findMovie(movieNameToSearch);

    if (movieResult) {
        userStates[chatId] = {
            ...userStates[chatId],
            lastFoundMovie: { id: movieResult.id, name: movieResult.filmName }
        };

        const successMessage = `Tickets are LIVE for *${movieResult.filmName}*! 🎉\n\nMovie ID: \`${movieResult.id}\``;
        const options = {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🗓️ Check Showtimes', callback_data: `showtimes_${movieResult.id}` }]
                ]
            }
        };
        bot.sendMessage(chatId, successMessage, options);
    } else {
        userStates[chatId] = { ...userStates[chatId], lastSearchedMovie: movieNameToSearch };
        const notFoundMessage = `😔 Sorry, I couldn't find "${movieNameToSearch}" currently showing in Bengaluru.\n\nWould you like to check if it's in the "Coming Soon" list?`;
        const options = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Yes, check Coming Soon', callback_data: 'check_coming_soon' }],
                    [{ text: '❌ No, thanks', callback_data: 'cancel_search' }]
                ]
            }
        };
        bot.sendMessage(chatId, notFoundMessage, options);
    }
});

// Listen for the /myalerts command
bot.onText(/\/myalerts/, (msg) => {
    const chatId = msg.chat.id;
    const userAlerts = activeAlerts[chatId];

    if (!userAlerts || userAlerts.length === 0) {
        bot.sendMessage(chatId, "You have no active alerts set. 🤷‍♂️");
        return;
    }

    let message = "🔔 *Here are your active alerts:*\n\n";
    userAlerts.forEach((alert, index) => {
        message += `*${index + 1}.* *Movie:* ${alert.movieName}\n`;
        message += `   *Cinema:* ${alert.cinemaName}\n`;
        message += `   *Date:* ${alert.date}\n\n`;
    });

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});


// Listen for button clicks
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const data = callbackQuery.data;

    if (data.startsWith('showtimes_')) {
        const movieId = data.split('_')[1];
        const lastFound = userStates[chatId] && userStates[chatId].lastFoundMovie;

        if (!lastFound || lastFound.id !== movieId) {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Your session has expired. Please try the /check command again.' });
            return;
        }
        const movieName = lastFound.name;
        userStates[chatId] = { action: 'awaiting_showtime_details', movieId: movieId, movieName: movieName };

        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        const exampleDate = `${yyyy}-${mm}-${dd}`;

        bot.sendMessage(chatId, `Please reply with the City, Date and Cinema Name, separated by commas.\n\n*Format:* \`City, YYYY-MM-DD, Cinema Name\`\n*Example:* \`Bengaluru, ${exampleDate}, PVR Forum Mall\``, { parse_mode: 'Markdown' });
        bot.answerCallbackQuery(callbackQuery.id);

    } else if (data === 'check_coming_soon') {
        const movieNameToSearch = userStates[chatId]?.lastSearchedMovie;
        if (!movieNameToSearch) {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired. Please start with /check again.' });
            return;
        }

        await bot.editMessageText(`🔍 Searching for "${movieNameToSearch}" in the coming soon list...`, { chat_id: chatId, message_id: msg.message_id });

        const movieResult = await findComingSoonMovie(movieNameToSearch);
        if (movieResult) {
            userStates[chatId].lastFoundMovie = { id: movieResult.id, name: movieResult.filmName };
            const successMessage = `✅ Found it! *${movieResult.filmName}* is coming soon.\n\nRelease Date: *${movieResult.releaseDate}*`;
            const options = {
                chat_id: chatId,
                message_id: msg.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔔 Set Alert for Bookings', callback_data: `showtimes_${movieResult.id}` }]
                    ]
                }
            };
            bot.editMessageText(successMessage, options);
        } else {
            bot.editMessageText(`😔 Sorry, I couldn't find "${movieNameToSearch}" in the coming soon list either.`, { chat_id: chatId, message_id: msg.message_id });
        }
        bot.answerCallbackQuery(callbackQuery.id);

    } else if (data === 'cancel_search') {
        bot.editMessageText("Ok, search cancelled.", { chat_id: chatId, message_id: msg.message_id });
        delete userStates[chatId];
        bot.answerCallbackQuery(callbackQuery.id);

    } else if (data === 'confirm_alert') {
        const alertDetails = userStates[chatId];
        if (!alertDetails || alertDetails.action !== 'awaiting_alert_confirmation') {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Session expired. Please try again.' });
            return;
        }

        if (!activeAlerts[chatId]) {
            activeAlerts[chatId] = [];
        }
        activeAlerts[chatId].push({
            movieId: alertDetails.movieId, movieName: alertDetails.movieName,
            date: alertDetails.date, cinemaName: alertDetails.cinemaName, city: alertDetails.city
        });

        await saveAlertsToFile(); // Save after adding an alert

        bot.editMessageText(`✅ Alert set! I will notify you when tickets for *${alertDetails.movieName}* become available at *${alertDetails.cinemaName}* in *${alertDetails.city}* on *${alertDetails.date}*.`, {
            chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown'
        });
        delete userStates[chatId];
        bot.answerCallbackQuery(callbackQuery.id);

    } else if (data === 'cancel_alert') {
        bot.editMessageText("Ok, I won't set an alert. You can always check again later!", {
            chat_id: chatId, message_id: msg.message_id,
        });
        delete userStates[chatId];
        bot.answerCallbackQuery(callbackQuery.id);
    }
});

/**
 * Periodically checks all active alerts by calling the API in parallel.
 */
async function checkAllAlerts() {
    const userCount = Object.keys(activeAlerts).length;
    if (userCount === 0) return;

    console.log(`[${new Date().toISOString()}] Running periodic check for ${userCount} user(s)...`);
    let alertsModified = false;

    // --- 1. Flatten all alerts from all users into a single array ---
    const allAlerts = [];
    for (const chatId in activeAlerts) {
        activeAlerts[chatId].forEach(alert => {
            allAlerts.push({ ...alert, chatId }); // Attach chatId to each alert for later use
        });
    }

    if (allAlerts.length === 0) return;

    // --- 2. Cleanup expired alerts first ---
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    const activeAndValidAlerts = allAlerts.filter(alert => {
        if (alert.date < today) {
            console.log(`[Cleanup] Removing expired alert for ${alert.movieName} on ${alert.date} for chat ID ${alert.chatId}.`);
            alertsModified = true;
            return false;
        }
        return true;
    });

    // --- 3. Create an array of promises (API calls) ---
    const promises = activeAndValidAlerts.map(alert =>
        findShowtimes(alert.movieId, alert.date, alert.cinemaName, alert.city)
            .then(result => ({ result, alert })) // Combine result with original alert data
            .catch(error => {
                console.error(`API call failed for alert: ${alert.movieName}`, error);
                return { result: null, alert }; // Return null result on failure
            })
    );

    // --- 4. Execute all promises in parallel ---
    const results = await Promise.all(promises);

    // --- 5. Process the results ---
    const fulfilledAlerts = new Set();
    for (const { result, alert } of results) {
        if (result && !result.error) {
            const message = `🚨 *TICKET ALERT!* 🚨\n\nTickets for *${alert.movieName}* are now available at *${alert.cinemaName}* for *${alert.date}*!\n\nShowtimes: \`${result.showtimes.join(' | ')}\``;
            await bot.sendMessage(alert.chatId, message, { parse_mode: 'Markdown' });
            console.log(`Sent alert to ${alert.chatId} for ${alert.movieName}`);

            // Mark this alert for removal
            fulfilledAlerts.add(`${alert.chatId}-${alert.movieId}-${alert.date}-${alert.cinemaName}`);
            alertsModified = true;
        }
    }

    // --- 6. Reconstruct the activeAlerts object, removing fulfilled alerts ---
    if (alertsModified) {
        const newActiveAlerts = {};
        allAlerts.forEach(alert => {
            const alertId = `${alert.chatId}-${alert.movieId}-${alert.date}-${alert.cinemaName}`;
            // Keep the alert if it's not expired and was not fulfilled
            if (alert.date >= today && !fulfilledAlerts.has(alertId)) {
                if (!newActiveAlerts[alert.chatId]) {
                    newActiveAlerts[alert.chatId] = [];
                }
                newActiveAlerts[alert.chatId].push({
                    movieId: alert.movieId,
                    movieName: alert.movieName,
                    date: alert.date,
                    cinemaName: alert.cinemaName,
                    city: alert.city
                });
            }
        });
        activeAlerts = newActiveAlerts;
        await saveAlertsToFile();
    }
}


// Immediately Invoked Function to load data and then start the interval
(async () => {
    await loadAlertsFromFile();
    checkAllAlerts();
    // Set an interval to run the alert checker every 15 minutes
    setInterval(checkAllAlerts, 15 * 60 * 1000);
    console.log("Periodic alert checker has been set up to run every 15 minutes.");
})();
