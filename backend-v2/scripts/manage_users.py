"""Staff accounts, from the command line (run from the backend-v2 folder).

    python -m scripts.manage_users demo                          # create the 4 demo accounts (sandbox only)
    python -m scripts.manage_users list
    python -m scripts.manage_users add dokter2 radiolog "dr. Nama, Sp.Rad"   # asks for the password
    python -m scripts.manage_users passwd radiolog                # asks for the new password
"""
import argparse
import getpass
import sys

from sqlalchemy import select

from app.core.db import SessionLocal
from app.modules.auth import service
from app.modules.auth.models import ROLE_LABELS, User

# Same demo accounts as the old backend. Course / sandbox use only.
DEMO_USERS = [
    ("admin", "admin123", "admin", "Administrator SIMRS"),
    ("radiografer", "radiografer123", "radiografer", "Rina Kartika, A.Md.Rad"),
    ("radiolog", "radiolog123", "radiolog", "dr. Rahmat Adiputra, Sp.Rad"),
    ("bedah", "bedah123", "dokter_bedah", "dr. Bima Santoso, Sp.B"),
]


def ask_password() -> str:
    first = getpass.getpass("Password: ")
    if len(first) < 8:
        sys.exit("Password must be at least 8 characters.")
    if getpass.getpass("Again: ") != first:
        sys.exit("Passwords do not match.")
    return first


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("demo")
    sub.add_parser("list")
    add = sub.add_parser("add")
    add.add_argument("username")
    add.add_argument("role", choices=list(ROLE_LABELS))
    add.add_argument("full_name")
    pw = sub.add_parser("passwd")
    pw.add_argument("username")
    args = parser.parse_args()

    with SessionLocal() as db, db.begin():
        if args.cmd == "demo":
            for username, password, role, full_name in DEMO_USERS:
                if db.scalar(select(User).where(User.username == username)):
                    print(f"  {username}: already exists, left as is")
                else:
                    service.create_user(db, username, password, role, full_name)
                    print(f"  {username}: created ({role})")
        elif args.cmd == "list":
            for u in db.scalars(select(User).order_by(User.username)):
                print(f"  {u.username:<14} {u.role_code:<13} {'active' if u.is_active else 'disabled':<9} {u.full_name}")
        elif args.cmd == "add":
            if db.scalar(select(User).where(User.username == args.username)):
                sys.exit(f"User '{args.username}' already exists.")
            service.create_user(db, args.username, ask_password(), args.role, args.full_name)
            print(f"Created {args.username}.")
        elif args.cmd == "passwd":
            if not service.set_password(db, args.username, ask_password()):
                sys.exit(f"No user '{args.username}'.")
            print(f"Password changed; {args.username} is logged out everywhere.")


if __name__ == "__main__":
    main()
