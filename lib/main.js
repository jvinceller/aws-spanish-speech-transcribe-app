/*
Original Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved. 
Modifications Copyright 2022 Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/

const audioUtils = require("./audioUtils"); // for encoding audio data as PCM
const crypto = require("crypto"); // tot sign our pre-signed URL
const v4 = require("./aws-signature-v4"); // to generate our pre-signed URL
const marshaller = require("@aws-sdk/eventstream-marshaller"); // for converting binary event stream messages to and from JSON
const util_utf8_node = require("@aws-sdk/util-utf8-node"); // utilities for encoding and decoding UTF8
const mic = require("microphone-stream"); // collect microphone input as a stream of raw bytes

AWS.config.region = amplifyConfig.Auth.region;


aws_amplify.Amplify.configure(amplifyConfig);

aws_amplify.Amplify.Auth.currentAuthenticatedUser().then(user => {
    //console.log('currentAuthenticatedUser', user);
    aws_amplify.Amplify.Auth.currentSession().then(data => {
        //console.log(data);
        AWS.config.credentials = new AWS.CognitoIdentityCredentials({IdentityPoolId: appConfig.IdentityPoolId, Logins: {['cognito-idp.'+amplifyConfig.Auth.region+'.amazonaws.com/'+amplifyConfig.Auth.userPoolId] : data.getIdToken().getJwtToken() }});
        AWS.config.credentials.get(function (err) {
            if (err) console.log(err);
            //  else console.log(AWS.config.credentials);
        });
        if (window.location.pathname === "/" || window.location.pathname === "/index.html")
            window.location.pathname = "/index-landing.html";
    }).catch(err => {
        console.log(err);
    });
}).catch(error => {
    console.log(error);
    if (window.location.pathname !== "/" && window.location.pathname !== "/index.html")
        window.location.pathname = "/";
});

function signIn() {
    const username = document.getElementById("username").value;
    const pass = document.getElementById("pwd").value;

    if ((!username || username.trim().length === 0) ||
      (!pass || pass.trim().length === 0)) {
        console.error('Username and password must be entered.');
        alert("Username and password must be entered.");
        return;
    }

    try {
        aws_amplify.Amplify.Auth.signIn(
          username, pass
        ).then(
          (user) => {
              console.log('Logged in user: ', user);
              const myTimeout = setTimeout(function() {location.reload();}, 2000);
          }
        ).catch(reason => {
            console.error(reason);
            alert("Error signing in.");
        });
    } catch (error) {
        console.error(error);
        alert("Error signing in.");
    }
}

$("#sign-in").click(function () {
    signIn();
});

$("#username").on("keydown", function (event) {
    if (event.which === 13) {
        signIn();
    }
});

$("#pwd").on("keydown", function (event) {
    if (event.which === 13) {
        signIn();
    }
});

$("#sign-out").click(function () {
    try {
        const user = aws_amplify.Amplify.Auth.signOut();
        const myTimeout = setTimeout(function() {location.reload();}, 2000);
    } catch (error) {
        console.error(error);
        alert("Error signing out.");
    }
});


/**
 * Amazon Cognito credentials provider initilization in case no Cognito User Pool is used 
 */

/*
AWS.config.credentials = new AWS.CognitoIdentityCredentials({
    IdentityPoolId: appConfig.IdentityPoolId,
});

// As of v2.1.20 the credentials are fetched lazily when a request is made. To explicitly get credentials you can use AWS.Credentials.get()
AWS.config.credentials.get(function (err) {
    if (err) console.log(err);
    //  else console.log(AWS.config.credentials);
});
*/


/**
 * Variables initilization
 */

// converter between binary event streams messages and JSON
const eventStreamMarshaller = new marshaller.EventStreamMarshaller(
    util_utf8_node.toUtf8,
    util_utf8_node.fromUtf8
);

const languageCode = 'es-US';
const region = amplifyConfig.Auth.region;
let sampleRate;
let inputSampleRate;
let transcription = "";
let socket;
let micStream;
let socketError = false;
let transcribeException = false;
let translation = "";

const pollyVoiceMap = new Map();
pollyVoiceMap.set("es-US", "Lupe");

const webcamElement = document.getElementById("webcam");
const canvasElement = document.getElementById("canvas");
const snapSoundElement = document.getElementById("snapSound");
const queryString = window.location.search;

// if (queryString !== "") {
//     const webcam = new Webcam(
//         webcamElement,
//         "user",
//         canvasElement,
//         snapSoundElement
//     );
//     $(".md-modal").addClass("md-show");
//     webcam
//         .start()
//         .then((result) => {
//             cameraStarted();
//         })
//         .catch((err) => {
//             displayError();
//         });
// }

//  Check to see if the browser allows mic access
if (!window.navigator.mediaDevices.getUserMedia) {
    showError(
        "We support the latest versions of Chrome, Firefox, Safari, and Edge. Update your browser and try your request again."
    );
}


/**
 * Click and Change events handling
 */

$("#start-button").click(function () {
    $("#error").hide(); // hide any existing errors
    toggleStartStop(); // disable start and enable stop button
    setSampleRate(); // set the language and region from the dropdowns
    window.navigator.mediaDevices
        .getUserMedia({
            // first we get the microphone input from the browser (as a promise)
            video: false,
            audio: true,
        })
        .then(streamAudioToWebSocket) // we convert the mic stream to binary event stream messages when the promise resolves
        .catch(function (error) {
            showError(
                "There was an error streaming your audio to Amazon Transcribe. Please try again."
            );
            console.log(error);
            toggleStartStop();
        });
    document.getElementById("listening-animation").style.display = "flex";
});

$("#stop-button").click(function () {
    closeSocket();
    toggleStartStop();
    document.getElementById("listening-animation").style.display = "none";
});

$("#reset-button").click(function () {
    $("#transcript").val("");
    transcription = "";
    $("#translate").val("");
    translation = "";
});

$("#play-button").click(function () {
    speakText();
});


/**
 * Some more initialization tasks
 */

const streamAudioToWebSocket = function (userMediaStream) {
    micStream = new mic(); //let's get the mic input from the browser, via the microphone-stream module

    micStream.on("format", function (data) {
        inputSampleRate = data.sampleRate;
    });

    micStream.setStream(userMediaStream);

    const url = createPresignedUrl(); // Pre-signed URLs are a way to authenticate a request (or WebSocket connection, in this case)
    socket = new WebSocket(url); // open up our WebSocket connection
    socket.binaryType = "arraybuffer";
    socket.onopen = function () {
        // when we get audio data from the mic, send it to the WebSocket if possible
        micStream.on("data", function (rawAudioChunk) {
            const binary = convertAudioToBinaryMessage(rawAudioChunk); // the audio stream is raw audio bytes. Transcribe expects PCM with additional metadata, encoded as binary
            if (socket.readyState === socket.OPEN) socket.send(binary);
        });
    };
    wireSocketEvents(); // handle messages, errors, and close events
};

function setSampleRate() {
    sampleRate = 44100;
}



/**
 * Functions for "Live transcription and text-to-speeech", "Live transcription and text-to-speeech with translation" features
 */

function speakText() {
    setSampleRate();

    const voiceId = pollyVoiceMap.get(languageCode);

    // Create the JSON parameters for getSynthesizeSpeechUrl
    const speechParams = {
        OutputFormat: "mp3",
        SampleRate: "16000",
        Text: "",
        TextType: "text",
        VoiceId: voiceId,
        Engine: "standard"
    };

    speechParams.Engine = "neural";
    speechParams.Text = document.getElementById("textEntry").value;

    // Create the Polly service object and presigner object
    const polly = new AWS.Polly({apiVersion: "2016-06-10"});
    const signer = new AWS.Polly.Presigner(speechParams, polly);

    // Create presigned URL of synthesized speech file
    signer.getSynthesizeSpeechUrl(speechParams, function (error, url) {
        if (error) {
            document.getElementById("result").innerHTML = "Oops! Something went wrong.";
        } else {
            document.getElementById("audioSource").src = url;
            if (document.getElementById("audioPlayback").style.display === "none")
                document.getElementById("audioPlayback").style.display = "block";
            document.getElementById("audioPlayback").load();
            //document.getElementById("result").innerHTML = "Ready!";
        }
    });
}

/**
 * Functions for "Real-time conversation translation" feature
 */

function wireSocketEvents() {
    // handle inbound messages from Amazon Transcribe
    socket.onmessage = function (message) {
        //convert the binary event stream message to JSON
        const messageWrapper = eventStreamMarshaller.unmarshall(
            Buffer(message.data)
        );
        const messageBody = JSON.parse(
            String.fromCharCode.apply(String, messageWrapper.body)
        );
        if (messageWrapper.headers[":message-type"].value === "event") {
            handleEventStreamMessage(messageBody);
        } else {
            transcribeException = true;
            showError(messageBody.Message);
            toggleStartStop();
        }
    };

    socket.onerror = function () {
        socketError = true;
        showError("WebSocket connection error. Try again.");
        toggleStartStop();
    };

    socket.onclose = function (closeEvent) {
        micStream.stop();

        // the close event immediately follows the error event; only handle one.
        if (!socketError && !transcribeException) {
            if (closeEvent.code !== 1000) {
                showError(
                    "</i><strong>Streaming Exception</strong><br>" +
                        closeEvent.reason
                );
                toggleStartStop();
            }
        }
    };
}

const handleEventStreamMessage = function (messageJson) {
    const results = messageJson.Transcript.Results;
    if (results.length > 0) {
        if (results[0].Alternatives.length > 0) {
            let languageCodeFromStream = "";
            if (typeof results[0].LanguageCode != "undefined" && languageCodeFromStream !== results[0].LanguageCode) {
                languageCodeFromStream = results[0].LanguageCode;
                const languageSelectionElement = document.getElementById("language");
                languageSelectionElement.value = languageCodeFromStream;
                document.getElementById("textToSynth").style.display = "block";
                document.getElementById("textToSynth-not-ready").style.display = "none";
            }
            // fix encoding for accented characters
            const transcript = decodeURIComponent(escape(results[0].Alternatives[0].Transcript));

            // update the textarea with the latest result
            $("#transcript").val(transcription + transcript + "\n");
            $('#transcript').scrollTop($('#transcript')[0].scrollHeight);

            // if this transcript segment is final, add it to the overall transcription
            if (!results[0].IsPartial) {
                $('#transcript').scrollTop($('#transcript')[0].scrollHeight);
                transcription += transcript + "\n";

                if (typeof document.getElementById("translateTo") != "undefined" && document.getElementById("translateTo") != null)
                    translateInput(transcript, function (translated) {
                        //location.href = "#";
                        //location.href = "#translate-div";
                        translation += translated + "\n";
                        $("#translate").val(translation + "\n");
                        $('#translate').scrollTop($('#translate')[0].scrollHeight);
                    });
            }
        }
    }
};

const closeSocket = function () {
    if (socket.readyState === socket.OPEN) {
        micStream.stop();

        // Send an empty frame so that Transcribe initiates a closure of the WebSocket after submitting all transcripts
        const emptyMessage = getAudioEventMessage(Buffer.from(new Buffer([])));
        const emptyBuffer = eventStreamMarshaller.marshall(emptyMessage);
        socket.send(emptyBuffer);
    }
};

function translateInput(text, callback) {
    const source_language = "auto";
    const target_language = $("#translateTo")
        .find(":selected")
        .val()
        .substring(0, 2);

    const translate = new AWS.Translate();
    const params = {
        SourceLanguageCode: source_language,
        TargetLanguageCode: target_language,
        Text: text,
    };
    translate.translateText(params, function (err, data) {
        callback(data.TranslatedText);
    });
}

function toggleStartStop() {
    if (document.getElementById("start-button").style.display === "none") {
        document.getElementById("start-button").style.display = "block";
    } else {
        document.getElementById("start-button").style.display = "none";
    }

    if (document.getElementById("stop-button").style.display === "none") {
        document.getElementById("stop-button").style.display = "block";
    } else {
        document.getElementById("stop-button").style.display = "none";
    }
}

function showError(message) {
    $("#error").html('<i class="fa fa-times-circle"></i> ' + message);
    $("#error").show();
}

function convertAudioToBinaryMessage(audioChunk) {
    const raw = mic.toRaw(audioChunk);
    if (raw == null) return;

    // downsample and convert the raw audio bytes to PCM
    const downsampledBuffer = audioUtils.downsampleBuffer(
        raw,
        inputSampleRate,
        sampleRate
    );
    const pcmEncodedBuffer = audioUtils.pcmEncode(downsampledBuffer);

    // add the right JSON headers and structure to the message
    const audioEventMessage = getAudioEventMessage(Buffer.from(pcmEncodedBuffer));

    //convert the JSON object + headers into a binary event stream message
    return eventStreamMarshaller.marshall(audioEventMessage);
}

function getAudioEventMessage(buffer) {
    // wrap the audio data in a JSON envelope
    return {
        headers: {
            ":message-type": {
                type: "string",
                value: "event",
            },
            ":event-type": {
                type: "string",
                value: "AudioEvent",
            },
        },
        body: buffer,
    };
}

function createPresignedUrl() {
    const endpoint = "transcribestreaming." + region + ".amazonaws.com:8443";

    // get a preauthenticated URL that we can use to establish our WebSocket
    return v4.createPresignedURL(
        "GET",
        endpoint,
        "/stream-transcription-websocket",
        "transcribe",
        crypto.createHash("sha256").update("", "utf8").digest("hex"),
        {
            key: AWS.config.credentials.accessKeyId,
            secret: AWS.config.credentials.secretAccessKey,
            sessionToken: AWS.config.credentials.sessionToken,
            protocol: "wss",
            expires: 15,
            region: region,
            query:
                "language-code=" +
                languageCode +
                "&media-encoding=pcm&sample-rate=" +
                sampleRate,
        }
    );
}
