import TelegramBot from "node-telegram-bot-api";
import axios from 'axios'
import moment from 'moment-timezone'
import { setTimeout } from "timers/promises";
import mongoose from "mongoose";
import dotenv from "dotenv";
import googleTTS from 'google-tts-api';

dotenv.config();

const token = process.env.TOKEN; // Your bot token (BOT_TOKEN)

const bot = new TelegramBot(token, {
  polling: {
    interval: 300, // This should be a number
    // other options...
  }
});

mongoose.connect(process.env.DB)
.then(()=>{
  console.log('Mongo Database connected')
})
.catch(err=>{ console.log('MongoDB connection error')})

const reminderSchema = new mongoose.Schema({
  userId: String,
  task: String,
  reminderTime: Date,
  isRecurring: Boolean,
  frequency: String, // daily, weekly, monthly
  timeZone: String, // UTC, IST, etc. store users timezome
});

const Reminder = mongoose.model('Reminder', reminderSchema );

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    'Welcome! Send me a reminder in the format "task by HH:MM" or "Task every {frequency} @ HH:MM".Use /settimezone to set your time zone'
  );
});

// set time zone command
bot.onText(/\settimezone(.+)/, async (msg, match) => {
  const userId = msg.chat.id;
  const timeZone = match[1];

  //Validate time zone
  if (!moment.tz.zone(timeZone)) {
    return bot.sendMessage(
      userId,
      'Invalid time zone. Please use a valid time zone(e.g,"West Africa/Lagos")'
    );
  }

  // Update or create user time zone
  await Reminder.updateMany({ userId }, { timeZone }, { upsert: true });
  bot.sendMessage(userId, `Time zone set to ${timeZone}.`);
});
// set reminder command
bot.onText(/(.+)by(\d{1,2}:\d{2})/, async (msg, match) => {
  const task = match[1];
  const timeStr = match[2];
  const userId = msg.chat.id;

  const userReminder = await Reminder.findOne({ userId });
  const timeZone = userReminder ? userReminder.timeZone : "UTC";

  const [hours, minutes] = timeStr.split(":").map(Number);
  const now = moment.tz(timeZone);
  const reminderTime = moment.tz(
    {
      year: now.year(),
      month: now.month(),
      date: now.date(),
      hour: hours,
      minute: minutes,
    },
    timeZone
  );

  if (reminderTime.isBefore(now)) {
    reminderTime.add(1, "day"); // schedule for the next day if the time has passed
  }

  const reminder = new Reminder({
    userId,
    task,
    reminderTime: reminderTime.toDate(),
    isRecurring: false,
    timeZone,
  });
  await reminder.save();

  bot.sendMessage(
    userId,
    `Reminder set for "${task}" at ${reminderTime.format(
      "HH:MM"
    )} (${timeZone}).`
  );

  scheduleReminder(reminder);
});

// Set recurring reminder command
bot.onText(
  /(.+) every (daily|weekly) at (\d{1,2}:\d{2})/,
  async (msg, match) => {
    const task = match[1];
    const frequency = match[2];
    const timeStr = match[3];
    const userId = msg.chat.id;

    const userReminder = await Reminder.findOne({ userId });
    const timeZone = userReminder ? userReminder.timeZone : "UTC"; // Default to UTC if not set

    const [hours, minutes] = timeStr.split(":").map(Number);
    const now = moment.tz(timeZone);

    const reminderTime = moment.tz(
      {
        year: now.year(),
        month: now.month(),
        date: now.date(),
        hour: hours,
        minute: minutes,
      },
      timeZone
    );

    if (reminderTime.isBefore(now)) {
      reminderTime.add(1, "day"); // Schedule for the next day if time has passed
    }

    const reminder = new Reminder({
      userId,
      task,
      reminderTime: reminderTime.toDate(),
      isRecurring: true,
      frequency,
      timeZone,
    });
    await reminder.save();

    bot.sendMessage(
      userId,
      `Recurring reminder set for "${task}" every ${frequency} at ${reminderTime.format(
        "HH:mm"
      )} (${timeZone}).`
    );

    scheduleRecurringReminder(reminder);
  }
);

// View reminders command
bot.onText(/\/viewreminders/, async (msg) => {
  const userId = msg.chat.id;
  const reminders = await Reminder.find({ userId });

  if (reminders.length === 0) {
    return bot.sendMessage(userId, "You have no reminders set.");
  }

  const reminderList = reminders
    .map((reminder, index) => {
      const reminderTime = moment(reminder.reminderTime)
        .tz(reminder.timeZone)
        .format("HH:mm");
      return `${index + 1}.${reminder.task} at ${reminderTime}(${reminder.isRecurring ? `every ${reminder.frequency}` : "one-time"
        })`;
    })
    .join("\n");

  bot.sendMessage(userId, `Your reminders:\n${reminderList}`);
});

// Delete reminder command
bot.onText(/\/deletereminder (\d+)/, async (msg, match) => {
  const userId = msg.chat.id;
  const reminderIndex = parseInt(match[1]) - 1;

  const reminders = await Reminder.find({ userId });

  if (reminderIndex < 0 || reminderIndex >= reminders.length) {
    return bot.sendMessage(
      userId,
      "Invalid reminder index. Please check your reminders and try again."
    );
  }

  await reminders[reminderIndex].remove();
  bot.sendMessage(userId, "Reminder deleted successfully.");
});

// Schedule a single reminder
function scheduleReminder(reminder) {
  const delay = reminder.reminderTime - new Date();
  setTimeout(delay).then(() => {
    sendVoiceReminder(reminder.userId, reminder.task);
    reminder.remove(); // Remove the reminder after sending
  });
}

// Schedule a recurring reminder
function scheduleRecurringReminder(reminder) {
  const now = new Date();
  let nextReminderTime = new Date(reminder.reminderTime);

  const interval =
    reminder.frequency === "daily"
      ? 24 * 60 * 60 * 1000
      : 7 * 24 * 60 * 60 * 1000; // Daily or weekly

  const checkNextReminder = () => {
    const delay = nextReminderTime - now;
    if (delay <= 0) {
      sendVoiceReminder(reminder.userId, reminder.task);
      nextReminderTime = new Date(nextReminderTime.getTime() + interval);
    }
    setTimeout(1000).then(checkNextReminder); // Check every second
  };
  checkNextReminder();
}
async function sendVoiceReminder(userId, task) {
  const url = googleTTS.getAudioUrl(task, {
    lang: 'en',
    slow: false,
    host: 'https://translate.google.com',

  });
  await bot.sendAudio(userId, url)
}

