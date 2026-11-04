import sys
from PySide6.QtWidgets import QApplication, QMainWindow
from helper import make_title, APP_VERSION

app = QApplication(sys.argv)
win = QMainWindow()
win.setWindowTitle(make_title(APP_VERSION))
