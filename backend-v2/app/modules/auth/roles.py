"""Who may call what (same groups as the old backend). Pages hide what a role cannot use;
these checks on the server are the real guard."""
ADMIN = ("admin",)
REPORTERS = ("radiolog", "admin")                                    # write the reading, send to SATUSEHAT
ARCHIVE_WRITE = ("radiografer", "admin")                             # upload studies, send requests back
ARCHIVE_READ = ("radiografer", "radiolog", "dokter_bedah", "admin")  # see patients, requests, studies
ORDERERS = ("dokter_bedah", "admin")                                 # request radiology exams
REGISTRARS = ("dokter_bedah", "admin")                               # register patients (+ SATUSEHAT)
BEDAH = ("dokter_bedah", "admin")                                    # surgery schedule + operation report
