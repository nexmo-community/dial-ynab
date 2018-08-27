require('dotenv').config();
const levenshtein = require('fast-levenshtein');

const Nexmo = require('nexmo');
const nexmo = new Nexmo({
    apiKey: 'unused',
    apiSecret: 'unused',
    applicationId: process.env.NEXMO_APPLICATION_ID,
    privateKey: process.env.NEXMO_PRIVATE_KEY,
});


const Speech = require('@google-cloud/speech');
const speech = new Speech.SpeechClient();
const googleConfig = {
    config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 8000,
        languageCode: 'en-GB'
    },
    interimResults: false
};

const ynabClient = require("ynab");
const ynab = new ynabClient.API(process.env.YNAB_ACCESS_TOKEN);

const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const expressWs = require('express-ws')(app);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Routes go here

app.get('/webhooks/answer', function (req, res) {
    return res.json([
        {
            "action": "talk",
            "text": "Please say the name of the category you would like the balance for"
        },
        {
            "action": "connect",
            "endpoint": [
                {
                    "type": "websocket",
                    "content-type": "audio/l16;rate=8000",
                    "uri": `ws://${req.get('host')}/transcription`,
                    "headers": {
                        "user": req.query.uuid
                    }
                }
            ]
        }
    ]);
});

app.ws('/transcription', function(ws, req) {
    let UUID;

    const speechStream = speech.streamingRecognize(googleConfig)
        .on('error', console.log)
        .on('data', async (data) => {
            if (!data.results) { return; }
            const translation = data.results[0].alternatives[0];
            console.log(translation.transcript);

            const categories = await fetchYnabBalanceData();
            const category = findClosestName(translation.transcript, categories);
            console.log(category);

            const balanceText = `<speak>${category.name} has <say-as interpret-as="vxml:currency">GBP${category.balance}</say-as> available</speak>`;

            nexmo.calls.talk.start(UUID, { text: balanceText }, (err, res) => {
                if(err) { console.error(err); }
            });
        });

    ws.on('message', function(msg) {
        if (!Buffer.isBuffer(msg)) {
            let data = JSON.parse(msg);
            UUID = data.user;
            return;
        }

        speechStream.write(msg);
    });

    ws.on('close', function(){
        speechStream.destroy();
    });
});

app.listen(process.env.PORT, function () {
    console.log(`dial-ynab listening on port ${process.env.PORT}!`);
});

async function fetchYnabBalanceData() {
    let r = await ynab.categories.getCategories(process.env.YNAB_BUDGET_ID);
    return r.data.category_groups.reduce((acc, v) => acc.concat(
        v.categories.map((c) => { return {"name":c.name, "balance":c.balance/1000}; })
    ), []);
}

function findClosestName(needle, haystack) {
    needle = needle.toLowerCase();

    let shortestDistance = {"value": [], "distance": Number.MAX_SAFE_INTEGER};

    for (let k of haystack) {
        let name = k.name.toLowerCase();
        if (needle == name) {
            return k;
        }

        let distance = levenshtein.get(needle, name);
        if (distance < shortestDistance.distance) {
            shortestDistance.value = k;
            shortestDistance.distance = distance;
        }
    }

    return shortestDistance.value;
}

const request = require("request-promise");
async function fetchMonzoBalanceData() {
    const data = JSON.parse(await request({"uri": "https://api.monzo.com/pots", "headers": {"Authorization": `Bearer ${process.env.MONZO_ACCESS_TOKEN}`}}));
    return data.pots.map((v) => { v.balance = v.balance/100; return v; });
}
