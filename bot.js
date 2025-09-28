// Load environment variables from a .env file
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

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
// A simple in-memory store for active alerts.
const activeAlerts = {};


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
        console.error("Error in findMovie:", error.message);
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
        console.error("Error in findComingSoonMovie:", error.message);
        return null;
    }
}

/**
 * Fetches movie sessions for a given movie ID and filters them by date and cinema.
 * @param {string} movieId - The ID of the movie.
 * @param {string} targetDate - The date to search for (YYYY-MM-DD).
 * @param {string} targetCinema - The name of the cinema to search for.
 * @returns {Promise<object|null>} - An object with cinema details and showtimes, or null if not found.
 */
async function findShowtimes(movieId, targetDate, targetCinema) {
    const requestBody = {
        city: "Bengaluru",
        mid: movieId,
        experience: "ALL", specialTag: "ALL", lat: "12.915336", lng: "77.373046",
        lang: "ALL", format: "ALL", dated: targetDate ? targetDate : new Date().toISOString().slice(0,10), time: "08:00-24:00",
        cinetype: "ALL", hc: "ALL", adFree: false
    };

    try {
        const response = await axios.post(`${PVR_API_BASE_URL}/msessions`, requestBody, { headers: PVR_API_HEADERS });
        const sessions = response.data?.output?.movieCinemaSessions;
        if (!sessions || !Array.isArray(sessions)) {
            return { error: 'no_shows_on_date' };
        }

        const targetCinemaLower = targetCinema.toLowerCase().trim();
        const relevantShows = [];
        const cinemaData = sessions.find(s => s.cinema.name.toLowerCase().includes(targetCinemaLower));

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
        console.error("Error in findShowtimes:", error.message);
        return null;
    }
}

// Main message listener to handle conversations and general messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text.startsWith('/')) {
        return;
    }

    if (userStates[chatId] && userStates[chatId].action === 'awaiting_showtime_details') {
        const [date, ...cinemaParts] = text.split(',');
        const cinemaName = cinemaParts.join(',').trim();

        if (!date || !cinemaName) {
            bot.sendMessage(chatId, "❌ Invalid format. Please provide the date and cinema name separated by a comma.\n\nExample: `2025-09-23, PVR Global Mall`", { parse_mode: 'Markdown' });
            return;
        }

        const { movieId, movieName } = userStates[chatId];
        bot.sendMessage(chatId, `Checking showtimes for *${movieName}* at *${cinemaName}* on *${date.trim()}*...`, { parse_mode: 'Markdown' });

        const showtimesResult = await findShowtimes(movieId, date.trim(), cinemaName);

        if (showtimesResult && !showtimesResult.error) {
            const message = `✅ Found shows for *${showtimesResult.cinemaName}* on *${date.trim()}*:\n\nShowtimes: \`${showtimesResult.showtimes.join(' | ')}\``;
            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            delete userStates[chatId];
        } else if (showtimesResult && showtimesResult.error === 'cinema_not_found') {
            bot.sendMessage(chatId, `😔 Sorry, I couldn't find any cinema matching "${cinemaName}". Please check the spelling.`);
            delete userStates[chatId];
        } else if (showtimesResult && showtimesResult.error === 'no_shows_on_date') {
            userStates[chatId].action = 'awaiting_alert_confirmation';
            userStates[chatId].date = date.trim();
            userStates[chatId].cinemaName = cinemaName;

            const options = {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔔 Yes, set an alert', callback_data: 'confirm_alert' }],
                        [{ text: '❌ No, thanks', callback_data: 'cancel_alert' }]
                    ]
                }
            };
            bot.sendMessage(chatId, `😔 No shows found for *${movieName}* at "${cinemaName}" on ${date.trim()}.\n\nWould you like me to notify you if tickets become available?`, options);
        } else {
            bot.sendMessage(chatId, "😥 Something went wrong while fetching showtimes. Please try again later.");
            delete userStates[chatId];
        }
        return;
    }

    bot.sendMessage(chatId, 'Welcome to the Movie Ticket Alert Bot! 👋\n\nTo check if a movie is available, use the /check command followed by the movie name.\n\nFor example:\n/check Fighter');
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

        bot.sendMessage(chatId, `Please reply with the date and the cinema name, separated by a comma.\n\n*Format:* \`YYYY-MM-DD, Cinema Name\`\n*Example:* \`${exampleDate}, PVR Forum Mall\``, { parse_mode: 'Markdown' });
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
            date: alertDetails.date, cinemaName: alertDetails.cinemaName
        });

        bot.editMessageText(`✅ Alert set! I will notify you when tickets for *${alertDetails.movieName}* become available at *${alertDetails.cinemaName}* on *${alertDetails.date}*.`, {
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
 * Periodically checks all active alerts by calling the API.
 */
async function checkAllAlerts() {
    const userCount = Object.keys(activeAlerts).length;
    if (userCount === 0) return;

    console.log(`[${new Date().toISOString()}] Running periodic check for ${userCount} user(s)...`);

    // Get today's date in YYYY-MM-DD format for easy string comparison.
    // This removes the time component, preventing timezone issues.
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;

    for (const chatId in activeAlerts) {
        const userAlerts = activeAlerts[chatId];
        const remainingAlerts = [];

        for (const alert of userAlerts) {
            // Check if the alert's date is in the past.
            if (alert.date < todayStr) {
                console.log(`[Cleanup] Removing expired alert for ${alert.movieName} on ${alert.date} for chat ID ${chatId}.`);
                // By not pushing it to the remainingAlerts array, we effectively delete it.
                continue; // Move to the next alert
            }

            const { movieId, movieName, date, cinemaName } = alert;
            const showtimesResult = await findShowtimes(movieId, date, cinemaName);

            if (showtimesResult && !showtimesResult.error) {
                const message = `🚨 *TICKET ALERT!* 🚨\n\nTickets for *${movieName}* are now available at *${cinemaName}* for *${date}*!\n\nShowtimes: \`${showtimesResult.showtimes.join(' | ')}\``;
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                console.log(`Sent alert to ${chatId} for ${movieName}`);
            } else {
                // If the alert was not fulfilled and is not expired, keep it for the next check.
                remainingAlerts.push(alert);
            }
        }

        // Update the list of active alerts for the user.
        if (remainingAlerts.length > 0) {
            activeAlerts[chatId] = remainingAlerts;
        } else {
            // If a user has no more active alerts, remove them from the alerts object.
            delete activeAlerts[chatId];
        }
    }
}

// Set an interval to run the alert checker every 15 minutes
setInterval(checkAllAlerts, 15 * 60 * 1000);

console.log("Periodic alert checker has been set up to run every 15 minutes.");