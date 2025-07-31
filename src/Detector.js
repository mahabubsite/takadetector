import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, collection, query, onSnapshot } from 'firebase/firestore';

const __app_id = "moneydetector";

const __firebase_config = {
  apiKey: "AIzaSyCkytUf1yAvnGK_iuwUQC4_4BIpKTgHeCI",
  authDomain: "moneydetector-1abd5.firebaseapp.com",
  projectId: "moneydetector-1abd5",
  storageBucket: "moneydetector-1abd5.firebasestorage.app",
  messagingSenderId: "703659125757",
  appId: "1:703659125757:web:ddec838bc4250de6c40794"
};

const __initial_auth_token = null; // Dummy value, because we’re using anonymous login

// নিশ্চিত করুন যে __app_id, __firebase_config, এবং __initial_auth_token পরিবেশে সংজ্ঞায়িত আছে
// Canvas environment থেকে গ্লোবাল ভেরিয়েবল ব্যবহার করুন
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ?(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// অডিও প্লেব্যাকের জন্য base64 কে ArrayBuffer এ রূপান্তর করার সহায়ক ফাংশন
function base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

// PCM কে WAV এ রূপান্তর করার সহায়ক ফাংশন (TTS অডিও প্লেব্যাকের জন্য প্রয়োজন)
function pcmToWav(pcmData, sampleRate) {
    const numChannels = 1; // মনো অডিও
    const bytesPerSample = 2; // 16-বিট PCM
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;

    const wavBuffer = new ArrayBuffer(44 + pcmData.byteLength);
    const view = new DataView(wavBuffer);

    // RIFF chunk
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + pcmData.byteLength, true); // ChunkSize
    writeString(view, 8, 'WAVE');

    // FMT sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true); // BitsPerSample

    // DATA sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, pcmData.byteLength, true); // Subchunk2Size

    // Write PCM data
    const pcmBytes = new Uint8Array(pcmData.buffer);
    for (let i = 0; i < pcmBytes.length; i++) {
        view.setUint8(44 + i, pcmBytes[i]);
    }

    return new Blob([view], { type: 'audio/wav' });
}

function writeString(view, offset, s) {
    for (let i = 0; i < s.length; i++) {
        view.setUint8(offset + i, s.charCodeAt(i));
    }
}

const Detector = () => {
    const [db, setDb] = useState(null);
    // eslint-disable-next-line no-unused-vars
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);

    const [selectedImage, setSelectedImage] = useState(null);
    const [imagePreview, setImagePreview] = useState(null);
    const [detectedCurrencyInfo, setDetectedCurrencyInfo] = useState(null); // শেষ সনাক্ত করা নোটের বিবরণ
    const [detectedNotes, setDetectedNotes] = useState([]); // মোট সংখ্যাসূচক মানের জন্য
    const totalBdtAmount = detectedNotes.reduce((sum, note) => sum + note, 0);

    const [targetCurrency, setTargetCurrency] = useState('USD');
    const [convertedAmount, setConvertedAmount] = useState(null);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState('');
    const [showConfirmDenomination, setShowConfirmDenomination] = useState(false);
    const [manualDenomination, setManualDenomination] = useState('');
    const [currencyHistory, setCurrencyHistory] = useState([]);
    // মুদ্রা API কী এর জন্য নতুন স্টেট - এখন আর প্রয়োজন নেই, তাই সরানো হয়েছে

    // হার্ডকোড করা বিনিময় হার (উদাহরণস্বরূপ, রিয়েল-টাইম নয়)
    const hardcodedExchangeRates = {
        'USD': 0.0085, // 1 BDT = ~0.0085 USD (উদাহরণ)
        'EUR': 0.0078, // 1 BDT = ~0.0078 EUR (উদাহরণ)
        'GBP': 0.0067, // 1 BDT = ~0.0067 GBP (উদাহরণ)
        'INR': 0.70,   // 1 BDT = ~0.70 INR (উদাহরণ)
        'JPY': 1.25,   // 1 BDT = ~1.25 JPY (উদাহরণ)
        'AUD': 0.012,  // 1 BDT = ~0.012 AUD (উদাহরণ)
        'CAD': 0.011,  // 1 BDT = ~0.011 CAD (উদাহরণ)
    };

    const currencyDetails = {
        '1 Taka': {
            value: 1,
            description: 'The 1 Taka note features a Royal Bengal Tiger watermark, a security thread, and a diamond pattern see-through image.',
            features: [
                'Watermark: Royal Bengal Tiger',
                'Security Thread',
                'See-through image: Diamond pattern',
                'Dimensions: 100x60mm'
            ]
        },
        '2 Taka': {
            value: 2,
            description: 'The 2 Taka note typically features the portrait of Bangabandhu Sheikh Mujibur Rahman and the Shaheed Minar (Martyrs\' Monument) on the reverse.',
            features: [
                'Portrait of Bangabandhu Sheikh Mujibur Rahman',
                'Shaheed Minar (reverse)',
                'Watermark',
                'Security thread'
            ]
        },
        '5 Taka': {
            value: 5,
            description: 'The 5 Taka note often depicts the portrait of Bangabandhu Sheikh Mujibur Rahman and the Kazi Nazrul Islam Mosque.',
            features: [
                'Portrait of Bangabandhu Sheikh Mujibur Rahman',
                'Kazi Nazrul Islam Mosque (reverse)',
                'Watermark',
                'Security thread'
            ]
        },
        '10 Taka': {
            value: 10,
            description: 'The 10 Taka note features the portrait of Bangabandhu Sheikh Mujibur Rahman and the Baitul Mukarram Mosque.',
            features: [
                'Portrait of Bangabandhu Sheikh Mujibur Rahman',
                'Baitul Mukarram Mosque (reverse)',
                'Watermark',
                'Security thread'
            ]
        },
        '20 Taka': {
            value: 20,
            description: 'The 20 Taka note typically shows the portrait of Bangabandhu Sheikh Mujibur Rahman and the Sixty Dome Mosque.',
            features: [
                'Portrait of Bangabandhu Sheikh Mujibur Rahman',
                'Sixty Dome Mosque (reverse)',
                'Watermark',
                'Security thread'
            ]
        },
        '50 Taka': {
            value: 50,
            description: 'The 50 Taka note features the portrait of Bangabandhu Sheikh Mujibur Rahman and the Shilpacharya Zainul Abedin Museum.',
            features: [
                'Portrait of Bangabandhu Sheikh Mujibur Rahman',
                'Shilpacharya Zainul Abedin Museum (reverse)',
                'Watermark',
                'Security thread',
                'Optically Variable Ink (OVI)'
            ]
        },
        '100 Taka': {
            value: 100,
            description: 'The 100 Taka note includes the portrait of Bangabandhu Sheikh Mujibur Rahman and the Star Mosque.',
            features: [
                'Portrait of Bangabandhu Sheikh Mujibur Rahman',
                'Star Mosque (reverse)',
                'Watermark',
                'Security thread',
                'Optically Variable Ink (OVI)'
            ]
        },
        '200 Taka': {
            value: 200,
            description: 'The 200 Taka note, issued to commemorate Bangabandhu Sheikh Mujibur Rahman\'s birth centenary, features his portrait and a collage of images representing his life and work.',
            features: [
                'Portrait of Bangabandhu Sheikh Mujibur Rahman',
                'Commemorative design',
                'Watermark',
                'Security thread',
                'Optically Variable Ink (OVI)'
            ]
        },
        '500 Taka': {
            value: 500,
            description: 'The 500 Taka note features the portrait of Bangabandhu Sheikh Mujibur Rahman, the National Monument, and Optically Variable Ink (OVI) that shifts color from red to light green.',
            features: [
                'Watermark: Portrait of Bangabandhu Sheikh Mujibur Rahman, numerical \'500\', Bangladesh Bank logo',
                'Intaglio Ink: Rough texture on portrait and slanted lines',
                'Optically Variable Ink (OVI): \'500\' shifts from red to light green',
                'Security Thread: 4mm, embedded, with Bank logo and \'500 Taka\' text (white directly, black at 90 degrees)',
                'Latent Image: \'500\' in lower border (visible horizontally)',
                'Microprints: \'BANGLADESH BANK\' text (requires magnifying glass)',
                'Portrait of Bangabandhu Sheikh Mujibur Rahman',
                'National Monument (light color in middle)',
                'Dimensions: 152x65mm'
            ]
        },
        '1000 Taka': {
            value: 1000,
            description: 'The 1000 Taka note features the portrait of Bangabandhu Sheikh Mujibur Rahman, the National Parliament building, and Optically Variable Ink (OVI) that shifts color from golden to green.',
            features: [
                'Watermark: Portrait of Bangabandhu Sheikh Mujibur Rahman, numerical \'1000\', Bangladesh Bank logo',
                'Intaglio Ink: Rough texture on portrait and slanted lines',
                'Optically Variable Ink (OVI): \'1000\' shifts from golden to green',
                'Security Thread: 4mm, embedded, with Bank logo and \'1000 Taka\' text (white directly, black at 90 degrees)',
                'Latent Image: \'1000\' in lower border (visible horizontally)',
                'Microprints: \'1000 TAKA\' and \'BANGLADESH BANK\' (requires magnifying glass)',
                'Iridescent Stripe: \'BANGLADESH BANK\' in light blue (color varies with oscillation)',
                'Portrait of Bangabandhu Sheikh Mujibur Rahman',
                'National Parliament building (intaglio ink on back)',
                'Dimensions: 160x70mm'
            ]
        },
    };

    useEffect(() => {
        // Firebase Initialize
        const app = initializeApp(firebaseConfig);
        const authInstance = getAuth(app);
        const dbInstance = getFirestore(app);
        setAuth(authInstance);
        setDb(dbInstance);

        const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
            if (user) {
                setUserId(user.uid);
            } else {
                // যদি কোনো ব্যবহারকারী লগ ইন না থাকে তাহলে অ্যানোনিমাসলি সাইন ইন করুন
                try {
                    // initialAuthToken শুধুমাত্র Canvas environment-এ উপলব্ধ।
                    // যদি এটি অন্য কোথাও চালানো হয়, তাহলে এটি null হবে এবং অ্যানোনিমাস সাইন-ইন হবে।
                    if (initialAuthToken) {
                        await signInWithCustomToken(authInstance, initialAuthToken);
                    } else {
                        await signInAnonymously(authInstance);
                    }
                    setUserId(authInstance.currentUser?.uid || crypto.randomUUID());
                } catch (error) {
                    console.error("Firebase authentication error:", error);
                    setMessage("Authentication failed. Please try again.");
                }
            }
            setIsAuthReady(true);
        });

        return () => unsubscribe();
    }, []);

    useEffect(() => {
        if (db && userId && isAuthReady) {
            const historyCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/currencyHistory`);
            const q = query(historyCollectionRef);

            const unsubscribe = onSnapshot(q, (snapshot) => {
                const history = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                setCurrencyHistory(history);
            }, (error) => {
                console.error("Error fetching currency history:", error);
                setMessage("Failed to load currency history.");
            });

            return () => unsubscribe();
        }
    }, [db, userId, isAuthReady]);

    // মোট BDT পরিবর্তিত হলে বা টার্গেট কারেন্সি পরিবর্তিত হলে স্বয়ংক্রিয়ভাবে রূপান্তর করার জন্য প্রভাব
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (totalBdtAmount > 0) {
            handleConvertCurrency(totalBdtAmount);
        } else {
            setConvertedAmount(null); // মোট 0 হলে রূপান্তর পরিষ্কার করুন
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [totalBdtAmount, targetCurrency]);


    const saveCurrencyDetection = async (denomination, description, features, imageBase64) => {
        if (!db || !userId) {
            setMessage("Error: User not authenticated or database not ready.");
            return;
        }
        try {
            const historyCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/currencyHistory`);
            await setDoc(doc(historyCollectionRef), {
                denomination,
                description,
                features,
                timestamp: new Date().toISOString(),
                imageBase64: imageBase64 // ইতিহাসের জন্য ছবি সংরক্ষণ করুন
            });
        } catch (error) {
            console.error("Error saving currency detection:", error);
            setMessage("Failed to save detection history.");
        }
    };

    const handleImageChange = (event) => {
        const file = event.target.files[0];
        if (file) {
            setSelectedImage(file);
            const reader = new FileReader();
            reader.onloadend = () => {
                setImagePreview(reader.result);
                // পূর্ববর্তী সনাক্তকরণ তথ্য রিসেট করুন (শেষ নোটের জন্য), কিন্তু মোট চলমান রাখুন
                setDetectedCurrencyInfo(null);
                setMessage('');
                setShowConfirmDenomination(false);
                setManualDenomination('');
            };
            reader.readAsDataURL(file);
        } else {
            setSelectedImage(null);
            setImagePreview(null);
        }
    };

    const handleDetectCurrency = async () => {
        if (!selectedImage) {
            setMessage('Please select an image first.');
            return;
        }

        setLoading(true);
        setMessage('Analyzing image...');

        try {
            const base64ImageData = imagePreview.split(',')[1];
            // সংখ্যাসূচক ডিনোমিনেশন সনাক্ত করার জন্য আরও নির্দিষ্ট প্রম্পট
            const prompt = "Identify the numerical denomination of the Bangladeshi Taka banknote in this image. For example, if it's a 100 Taka note, respond with '100'. If it's a 500 Taka note, respond with '500'. If you cannot confidently identify the denomination, respond with 'UNKNOWN'. Consider all known variants of Bangladeshi Taka notes (1, 2, 5, 10, 20, 50, 100, 200, 500, 1000).";


            const payload = {
                contents: [
                    {
                        role: "user",
                        parts: [
                            { text: prompt },
                            {
                                inlineData: {
                                    mimeType: selectedImage.type,
                                    data: base64ImageData
                                }
                            }
                        ]
                    }
                ],
            };
            // আপনার জেমিনি API কী এখানে বসান
            const apiKey = "AIzaSyDSfb88eDpoqUYzt7LmxLKmuW23iXvGVsM"; 
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();

            if (result.candidates && result.candidates.length > 0 &&
                result.candidates[0].content && result.candidates[0].content.parts &&
                result.candidates[0].content.parts.length > 0) {
                const text = result.candidates[0].content.parts[0].text.trim();
                setMessage(`AI Analysis: ${text}`);

                let inferredDenominationValue = null;
                if (text.toUpperCase() !== 'UNKNOWN') {
                    const value = parseInt(text, 10);
                    // পার্স করা মানটি আমাদের পরিচিত ডিনোমিনেশনের মধ্যে আছে কিনা তা পরীক্ষা করুন
                    if (!isNaN(value) && Object.values(currencyDetails).some(detail => detail.value === value)) {
                        inferredDenominationValue = value;
                    }
                }

                if (inferredDenominationValue) {
                    const denominationKey = `${inferredDenominationValue} Taka`;
                    setDetectedCurrencyInfo({
                        denomination: denominationKey,
                        description: currencyDetails[denominationKey].description,
                        features: currencyDetails[denominationKey].features,
                        apiDescription: text
                    });
                    setDetectedNotes(prev => [...prev, inferredDenominationValue]); // মোট যোগ করার জন্য তালিকায় যোগ করুন
                    await saveCurrencyDetection(denominationKey, currencyDetails[denominationKey].description, currencyDetails[denominationKey].features, imagePreview);
                    setMessage(`সনাক্ত করা হয়েছে: ${denominationKey}. মোট যোগ করা হয়েছে।`);
                    setShowConfirmDenomination(false); // সনাক্ত হলে ম্যানুয়াল নিশ্চিতকরণ লুকান
                } else {
                    setMessage('আত্মবিশ্বাসের সাথে ডিনোমিনেশন সনাক্ত করা যায়নি। অনুগ্রহ করে নিশ্চিত করুন বা ম্যানুয়ালি প্রবেশ করান।');
                    setShowConfirmDenomination(true);
                }
            } else {
                setMessage('ছবি বিশ্লেষণ করতে ব্যর্থ হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।');
            }
        } catch (error) {
            console.error('মুদ্রা সনাক্তকরণে ত্রুটি:', error);
            setMessage('ছবি বিশ্লেষণে ত্রুটি। অনুগ্রহ করে আবার চেষ্টা করুন।');
        } finally {
            setLoading(false);
        }
    };

    const handleConfirmDenomination = async () => {
        if (manualDenomination && currencyDetails[manualDenomination]) {
            const denominationValue = currencyDetails[manualDenomination].value;
            setDetectedCurrencyInfo({
                denomination: manualDenomination,
                description: currencyDetails[manualDenomination].description,
                features: currencyDetails[manualDenomination].features,
                apiDescription: `Manually confirmed as ${manualDenomination}`
            });
            setDetectedNotes(prev => [...prev, denominationValue]); // মোট যোগ করার জন্য তালিকায় যোগ করুন
            await saveCurrencyDetection(manualDenomination, currencyDetails[manualDenomination].description, currencyDetails[manualDenomination].features, imagePreview);
            setMessage(`ডিনোমিনেশন নিশ্চিত করা হয়েছে ${manualDenomination} হিসাবে। মোট যোগ করা হয়েছে।`);
            setShowConfirmDenomination(false);
        } else {
            setMessage('অনুগ্রহ করে একটি বৈধ বাংলাদেশী টাকার ডিনোমিনেশন নির্বাচন করুন।');
        }
    };

    const handleConvertCurrency = async (amountToConvert) => {
        if (!amountToConvert || isNaN(amountToConvert) || parseFloat(amountToConvert) <= 0) {
            setConvertedAmount(null);
            return;
        }

        setLoading(true);
        setMessage('মুদ্রা রূপান্তর করা হচ্ছে...');

        try {
            const rate = hardcodedExchangeRates[targetCurrency];
            if (rate) {
                setConvertedAmount(amountToConvert * rate);
                setMessage(`রূপান্তর সফল হয়েছে!`);
            } else {
                setMessage(`${targetCurrency} এর জন্য রূপান্তর হার উপলব্ধ নয়।`);
            }
        } catch (error) {
            console.error('মুদ্রা রূপান্তরে ত্রুটি:', error);
            setMessage('মুদ্রা রূপান্তরে ত্রুটি। অনুগ্রহ করে আবার চেষ্টা করুন।');
        } finally {
            setLoading(false);
        }
    };

    const handleSpeakText = async (text) => {
        setLoading(true);
        setMessage('বক্তৃতা তৈরি করা হচ্ছে...');
        try {
            const payload = {
                contents: [{
                    parts: [{ text: text }]
                }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: "Kore" } // একটি দৃঢ়, স্পষ্ট কণ্ঠস্বর
                        }
                    }
                },
                model: "gemini-2.5-flash-preview-tts"
            };
            // আপনার জেমিনি API কী এখানে বসান
            const apiKey = "AIzaSyDSfb88eDpoqUYzt7LmxLKmuW23iXvGVsM"; 
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            const part = result?.candidates?.[0]?.content?.parts?.[0];
            const audioData = part?.inlineData?.data;
            const mimeType = part?.inlineData?.mimeType;

            if (audioData && mimeType && mimeType.startsWith("audio/")) {
                const sampleRateMatch = mimeType.match(/rate=(\d+)/);
                const sampleRate = sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : 16000; // না পাওয়া গেলে 16kHz ডিফল্ট
                const pcmData = base64ToArrayBuffer(audioData);
                const pcm16 = new Int16Array(pcmData);
                const wavBlob = pcmToWav(pcm16, sampleRate);
                const audioUrl = URL.createObjectURL(wavBlob);

                const audio = new Audio(audioUrl);
                audio.play();
                setMessage('বক্তৃতা সফলভাবে তৈরি হয়েছে।');
            } else {
                setMessage('বক্তৃতা তৈরি করতে ব্যর্থ হয়েছে: কোনো অডিও ডেটা পাওয়া যায়নি।');
            }
        } catch (error) {
            console.error('বক্তৃতা তৈরি করতে ত্রুটি:', error);
            setMessage('বক্তৃতা তৈরি করতে ত্রুটি। অনুগ্রহ করে আবার চেষ্টা করুন।');
        } finally {
            setLoading(false);
        }
    };

    const handleClearDetections = () => {
        setDetectedNotes([]);
        setDetectedCurrencyInfo(null);
        setImagePreview(null);
        setSelectedImage(null);
        setMessage('');
        setConvertedAmount(null);
        setShowConfirmDenomination(false);
        setManualDenomination('');
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-green-100 to-blue-200 p-4 sm:p-8 flex flex-col items-center font-inter text-gray-800">
            <style>
                {`
                @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
                body {
                    font-family: 'Inter', sans-serif;
                }
                .btn-primary {
                    background-color: #4CAF50; /* সবুজ */
                    color: white;
                    padding: 10px 20px;
                    border-radius: 8px;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    transition: all 0.2s ease-in-out;
                    font-weight: 600;
                }
                .btn-primary:hover {
                    background-color: #45a049;
                    transform: translateY(-2px);
                    box-shadow: 0 6px 8px rgba(0, 0, 0, 0.15);
                }
                .btn-secondary {
                    background-color: #007BFF; /* নীল */
                    color: white;
                    padding: 10px 20px;
                    border-radius: 8px;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    transition: all 0.2s ease-in-out;
                    font-weight: 600;
                }
                .btn-secondary:hover {
                    background-color: #0056b3;
                    transform: translateY(-2px);
                    box-shadow: 0 6px 8px rgba(0, 0, 0, 0.15);
                }
                .btn-danger {
                    background-color: #dc3545; /* লাল */
                    color: white;
                    padding: 10px 20px;
                    border-radius: 8px;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                    transition: all 0.2s ease-in-out;
                    font-weight: 600;
                }
                .btn-danger:hover {
                    background-color: #c82333;
                    transform: translateY(-2px);
                    box-shadow: 0 6px 8px rgba(0, 0, 0, 0.15);
                }
                .input-field {
                    padding: 10px;
                    border-radius: 8px;
                    border: 1px solid #ccc;
                    width: 100%;
                    box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.05);
                }
                .card {
                    background-color: white;
                    border-radius: 12px;
                    box-shadow: 0 10px 20px rgba(0, 0, 0, 0.08);
                    padding: 24px;
                    margin-bottom: 24px;
                }
                `}
            </style>

            <h1 className="text-4xl font-bold text-green-700 mb-8 text-center">টাকাসেন্স: মুদ্রা সনাক্তকারী ও রূপান্তরকারী</h1>

            {userId && (
                <div className="text-sm text-gray-600 mb-4">
                    আপনার ব্যবহারকারী আইডি (User ID): <span className="font-semibold">{userId}</span>
                </div>
            )}

            <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* ছবি আপলোড ও সনাক্তকরণ বিভাগ */}
                <div className="card">
                    <h2 className="text-2xl font-semibold text-green-600 mb-4">বাংলাদেশী টাকা সনাক্ত করুন</h2>
                    <div className="mb-4">
                        <label htmlFor="image-upload" className="block text-sm font-medium text-gray-700 mb-2">নোটের ছবি আপলোড করুন:</label>
                        <input
                            type="file"
                            id="image-upload"
                            accept="image/*"
                            onChange={handleImageChange}
                            className="block w-full text-sm text-gray-500
                            file:mr-4 file:py-2 file:px-4
                            file:rounded-full file:border-0
                            file:text-sm file:font-semibold
                            file:bg-green-50 file:text-green-700
                            hover:file:bg-green-100"
                        />
                    </div>

                    {imagePreview && (
                        <div className="mb-4 flex flex-col items-center">
                            <img src={imagePreview} alt="প্রিভিউ" className="max-w-full h-auto rounded-lg shadow-md mb-4" style={{ maxHeight: '300px' }} />
                            <button
                                onClick={handleDetectCurrency}
                                className="btn-primary w-full sm:w-auto px-6 py-3"
                                disabled={loading}
                            >
                                {loading ? 'বিশ্লেষণ করা হচ্ছে...' : 'মুদ্রা সনাক্ত করুন'}
                            </button>
                        </div>
                    )}

                    {loading && (
                        <div className="text-center text-blue-600 mt-4">
                            লোড হচ্ছে...
                        </div>
                    )}

                    {message && (
                        <div className={`mt-4 p-3 rounded-lg ${message.includes('Error') ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>
                            {message}
                        </div>
                    )}

                    {showConfirmDenomination && (
                        <div className="mt-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                            <p className="text-yellow-800 mb-2">আত্মবিশ্বাসের সাথে সনাক্ত করা যায়নি। অনুগ্রহ করে ডিনোমিনেশন নির্বাচন করুন:</p>
                            <select
                                value={manualDenomination}
                                onChange={(e) => setManualDenomination(e.target.value)}
                                className="input-field mb-3"
                            >
                                <option value="">ডিনোমিনেশন নির্বাচন করুন</option>
                                {Object.keys(currencyDetails).map(denom => (
                                    <option key={denom} value={denom}>{denom}</option>
                                ))}
                            </select>
                            <button
                                onClick={handleConfirmDenomination}
                                className="btn-secondary w-full sm:w-auto px-6 py-3"
                            >
                                ডিনোমিনেশন নিশ্চিত করুন
                            </button>
                        </div>
                    )}

                    {detectedCurrencyInfo && (
                        <div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                            <h3 className="text-xl font-semibold text-green-800 mb-2">শেষ সনাক্ত করা নোট: {detectedCurrencyInfo.denomination}</h3>
                            <p className="text-gray-700 mb-3">{detectedCurrencyInfo.description}</p>
                            <h4 className="font-medium text-gray-800 mb-1">মূল নিরাপত্তা বৈশিষ্ট্য:</h4>
                            <ul className="list-disc list-inside text-gray-600">
                                {detectedCurrencyInfo.features.map((feature, index) => (
                                    <li key={index}>{feature}</li>
                                ))}
                            </ul>
                            <button
                                onClick={() => handleSpeakText(`This is a ${detectedCurrencyInfo.denomination} Bangladeshi Taka note. Key features include: ${detectedCurrencyInfo.features.join(', ')}.`)}
                                className="btn-secondary mt-4 px-4 py-2 text-sm"
                            >
                                বিবরণ বলুন
                            </button>
                        </div>
                    )}

                    {/* সনাক্ত করা নোটের তালিকা এবং মোট */}
                    <div className="mt-6 p-4 bg-purple-50 border border-purple-200 rounded-lg">
                        <h3 className="text-xl font-semibold text-purple-800 mb-2">সনাক্ত করা নোট:</h3>
                        {detectedNotes.length === 0 ? (
                            <p className="text-gray-600">এখনও কোনো নোট সনাক্ত করা হয়নি।</p>
                        ) : (
                            <ul className="list-disc list-inside text-gray-700">
                                {detectedNotes.map((note, index) => (
                                    <li key={index}>{note} টাকা</li>
                                ))}
                            </ul>
                        )}
                        <p className="mt-2 text-lg font-bold text-purple-900">মোট BDT: {totalBdtAmount.toFixed(2)}</p>
                        <button
                            onClick={handleClearDetections}
                            className="btn-danger mt-4 px-4 py-2 text-sm"
                        >
                            সমস্ত সনাক্তকরণ পরিষ্কার করুন
                        </button>
                    </div>
                </div>

                {/* মুদ্রা রূপান্তরকারী বিভাগ */}
                <div className="card">
                    <h2 className="text-2xl font-semibold text-blue-600 mb-4">মুদ্রা রূপান্তরকারী (BDT)</h2>
                    {/* API কী ইনপুট ফিল্ড সরানো হয়েছে */}
                    <div className="mb-4">
                        <label htmlFor="target-currency" className="block text-sm font-medium text-gray-700 mb-2">মোট BDT কে রূপান্তর করুন:</label>
                        <select
                            id="target-currency"
                            value={targetCurrency}
                            onChange={(e) => setTargetCurrency(e.target.value)}
                            className="input-field"
                        >
                            <option value="USD">USD - মার্কিন ডলার</option>
                            <option value="EUR">EUR - ইউরো</option>
                            <option value="GBP">GBP - ব্রিটিশ পাউন্ড</option>
                            <option value="INR">INR - ভারতীয় রুপি</option>
                            <option value="JPY">JPY - জাপানি ইয়েন</option>
                            <option value="AUD">AUD - অস্ট্রেলিয়ান ডলার</option>
                            <option value="CAD">CAD - কানাডিয়ান ডলার</option>
                            {/* আরও মুদ্রা যোগ করুন প্রয়োজন অনুযায়ী */}
                        </select>
                    </div>
                    {convertedAmount !== null && (
                        <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg text-center">
                            <p className="text-lg font-semibold text-blue-800">
                                {totalBdtAmount.toFixed(2)} BDT প্রায়{' '}
                                <span className="text-2xl text-blue-900">{convertedAmount.toFixed(2)} {targetCurrency}</span>
                            </p>
                            <button
                                onClick={() => handleSpeakText(`${totalBdtAmount.toFixed(2)} Bangladeshi Taka is approximately ${convertedAmount.toFixed(2)} ${targetCurrency}.`)}
                                className="btn-secondary mt-4 px-4 py-2 text-sm"
                            >
                                রূপান্তর বলুন
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* ইতিহাস বিভাগ */}
            <div className="card w-full max-w-4xl mt-6">
                <h2 className="text-2xl font-semibold text-purple-600 mb-4">সনাক্তকরণের ইতিহাস</h2>
                {currencyHistory.length === 0 ? (
                    <p className="text-gray-600">এখনও কোনো সনাক্তকরণের ইতিহাস নেই।</p>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {currencyHistory.map((entry) => (
                            <div key={entry.id} className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                                <p className="font-semibold text-purple-800">{entry.denomination}</p>
                                <p className="text-sm text-gray-700">{new Date(entry.timestamp).toLocaleString()}</p>
                                {entry.imageBase64 && (
                                    <img src={entry.imageBase64} alt="সনাক্ত করা নোট" className="mt-2 w-full h-24 object-cover rounded-md" />
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default Detector;
