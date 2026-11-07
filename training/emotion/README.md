# Experimental emotion head

The private Kaggle script `kaggle/train_emotion_head.py` freezes emotion2vec+ large
and trains a small four-class head. It is optional research for call analysis, not
a replacement for transcript-based checklist evaluation or a calibrated measure
of operator quality. Deployment inference must run locally.

`MODE = "full"` enables the bounded corpus caps documented in the script. Input
paths are resolved from actual files, with missing or ambiguous paths rejected
before embedding. All six RU train/test partitions and KazEmoTTS are required.
`coverage.json` records every failed decode by clip ID and partition; a failure
rate over 1% in any partition aborts score publication.

The previous smoke run processed 690 selected clips, with 490 successes and 200
missing podcast files. Its small-sample scores (Dusha 0.52 versus 0.30; RESD 0.50
versus 0.37) demonstrate the pipeline only. They do not validate generalization,
podcast performance, or real calls. KazEmoTTS is synthetic speech and needs a
separate real-call evaluation. The corrected full run has not been submitted or
validated yet.

Run the offline path regression tests with
`python -m pytest training/emotion/tests -q`. Submit the private kernel using
`kaggle kernels push -p training/emotion/kaggle`, then retrieve `coverage.json`,
`metrics.json`, the log and model artifacts. Check every partition before quoting
metrics. Do not add organizer recordings or credentials to the kernel or Git.
